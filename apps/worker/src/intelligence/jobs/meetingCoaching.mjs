// Meeting coaching — the content plugin that learns from OUR OWN side of the call.
// For every call we have a transcript of, it has Haiku tag a small, closed set of
// behaviors we control (did we set a next step, multithread, run discovery, raise
// pricing too early, dominate the talk time), ties each to whether the deal then
// advanced, and learns which behavior is the biggest lever. So the coaching stops
// guessing and tells you the move that has actually won here.
//
// This is the meeting counterpart to objectionCoaching: that learns from WHAT we
// write (sent replies), this learns from WHAT we do on calls. Both ride the same
// decision -> action -> outcome trace and the same MIN_SAMPLE honesty gate.
//
// Cost discipline: transcripts are the first thing the engine LLM-reads, so we label
// each call exactly once and cache the booleans as an ri_behaviors row keyed by the
// transcript note id — a second run analyzes zero already-seen calls.

import { getActiveObservations, getBehaviors, upsertBehaviors } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';
import { read, parseObject, acceptsObject } from '../../noema/read.mjs';

const KEY = 'meeting.coaching';
const BEHAVIOR_KEY = 'meeting.behaviors';
const EXTRACTOR_VERSION = 1;               // bump to force a re-label of every call
const DOC_TYPES = ['transcript', 'meeting_notes'];   // a call we can read
const ADVANCE_PROPS = [
  'interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held',
  'interaction.outbound_positive_reply', 'interaction.reply', 'interaction.email_reply',
];
const DAY = 86_400_000;
const OUTCOME_WINDOW_D = 30;    // an advance within this of the call counts as "advanced"
const LEARN_LOOKBACK_D = 180;   // calls older than this are stale for coaching
const MIN_CALLS = 8;            // = engine MIN_SAMPLE; below this the observation stays 'learning'
const MIN_BEHAVIOR_N = 3;      // a behavior needs this many calls each way before it can be a lever
const MAX_LABEL_PER_RUN = 40;   // bound the model spend per workspace per run
const MAX_CALLS = 400;          // bound the note scan
const MIN_TRANSCRIPT_CHARS = 400;
const TRANSCRIPT_CAP = 6000;    // intro + discovery + close is where these behaviors show

// The behaviors we recognise — a small, closed set we control on a call. `good:true`
// means doing it helps; `good:false` is a leak (pricing raised too early, we hogged
// the call). The model returns exactly these five booleans so we can aggregate.
const BEHAVIORS = [
  { key: 'next_step_set', good: true,  present: 'set a concrete next step',                     absent: "didn't lock a next step" },
  { key: 'multithreaded', good: true,  present: 'brought in or asked about other stakeholders', absent: 'stayed single-threaded' },
  { key: 'discovery_done', good: true, present: 'ran real discovery (pain + timeline/budget/authority)', absent: 'skipped discovery' },
  { key: 'pricing_early', good: false, present: 'raised pricing before establishing value',     absent: 'held pricing until value landed' },
  { key: 'rep_dominated', good: false, present: 'dominated the talk time',                       absent: 'gave the buyer room to talk' },
];
const BEHAVIOR_KEYS = BEHAVIORS.map((b) => b.key);

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;

const contentOf = (c) => c?.value?.content ?? '';
const docTypeOf = (c) => c?.value?.metadata?.doc_type ?? null;
const atOf = (c) => c?.last_observed_at || c?.valid_from || c?.computed_at || null;

const SYSTEM = `You review a sales/discovery call transcript and label how the SELLER (us, the host — not the prospect) ran it, for a coaching engine. Return whether each of these happened, judged ONLY from the transcript, never inferred beyond the text:
- "next_step_set": a concrete next step or next meeting was explicitly agreed.
- "multithreaded": we involved, named, or asked about other stakeholders / decision-makers.
- "discovery_done": we surfaced the buyer's pain AND at least one of timeline, budget, or authority.
- "pricing_early": pricing or cost was raised before value was established (a mistake — true means it happened).
- "rep_dominated": the seller did most of the talking and the buyer had little airtime.
Also return "call_summary": one short neutral sentence.

Return ONLY valid JSON, this exact shape and keys, booleans only:
{"next_step_set":false,"multithreaded":false,"discovery_done":false,"pricing_early":false,"rep_dominated":false,"call_summary":"..."}`;

// One model pass for one call → the five booleans + a summary. Returns null on any failure —
// which the caller skips over, so a run where every label failed and a run over calls the model
// had nothing to say about produced the same result: no coaching, and no reason why (GET-320).
// The old gate only asked for a { and a } somewhere in the answer, which let through text
// JSON.parse then threw on; it is now derived from the parser that reads the answer.
async function labelCall(text, supabase, workspaceId) {
  const result = await read({
    supabase, workspaceId,
    feature: 'meeting-coaching',
    meterAs: 'meeting-coaching',
    accept: acceptsObject,
    parse: parseObject,
    maxTokens: 400,
    system: SYSTEM,
    prompt: `TRANSCRIPT:\n${text.slice(0, TRANSCRIPT_CAP)}`,
  });
  if (!result.ok) {
    console.warn(`[ri.meetingCoaching] label pass failed: ${result.reason}`);
    return null;
  }
  const obj = result.value;
  const out = { call_summary: String(obj.call_summary ?? '').slice(0, 200) };
  for (const k of BEHAVIOR_KEYS) out[k] = obj[k] === true;
  return out;
}

export const meetingCoaching = {
  key: KEY,
  category: 'meeting',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Which things we do on a call actually advance the deal?',

  async learn(ctx) {
    const sinceCall = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();

    // 1. The calls we have a transcript of — notes carrying a call doc_type. doc_type
    //    lives in JSONB metadata, so filter it in JS (the notes.ts portability rule).
    const { data: notes } = await ctx.supabase.from('claims')
      .select('id, entity_id, value, valid_from, computed_at, last_observed_at')
      .eq('workspace_id', ctx.workspaceId).like('property', 'note.%').is('invalid_at', null)
      .order('last_observed_at', { ascending: false }).limit(MAX_CALLS);
    const calls = (notes ?? [])
      .filter((n) => n.entity_id && DOC_TYPES.includes(docTypeOf(n)) && contentOf(n).length >= MIN_TRANSCRIPT_CHARS)
      .map((n) => ({ id: n.id, entityId: n.entity_id, at: atOf(n), content: contentOf(n) }))
      .filter((c) => c.at && c.at >= sinceCall);
    if (calls.length < MIN_CALLS) return [];

    // 2. Labels we already computed (cached per call as an ri_behaviors row). Only the
    //    un-labeled calls cost a Haiku pass, and only up to MAX_LABEL_PER_RUN of them.
    const cached = await getBehaviors(ctx.supabase, ctx.workspaceId, { behaviorKey: BEHAVIOR_KEY, subjectType: 'call' });
    const labelById = new Map();
    for (const r of cached) { try { labelById.set(r.subject_id, JSON.parse(r.value_text)); } catch { /* skip */ } }

    const toLabel = calls.filter((c) => !labelById.has(c.id)).slice(0, MAX_LABEL_PER_RUN);
    const freshRows = [];
    for (const c of toLabel) {
      const label = await labelCall(c.content, ctx.supabase, ctx.workspaceId);
      if (!label) continue;
      labelById.set(c.id, label);
      freshRows.push({
        subjectType: 'call', subjectId: c.id, key: BEHAVIOR_KEY,
        valueText: JSON.stringify(label), evidenceIds: [c.id],
        extractorVersion: EXTRACTOR_VERSION, observedAt: c.at,
      });
    }
    if (freshRows.length) await upsertBehaviors(ctx.supabase, ctx.workspaceId, freshRows);

    const labeled = calls.filter((c) => labelById.has(c.id));
    if (labeled.length < MIN_CALLS) return [];

    // 3. The outcome per call — an advance signal on that account after the call, within
    //    the window. Read the props for the workspace and group in JS (the speed-to-lead
    //    pattern; a per-entity .in() blows the URL limit at scale).
    const entityIds = new Set(labeled.map((c) => c.entityId));
    const sinceEvents = new Date(Date.now() - (LEARN_LOOKBACK_D + OUTCOME_WINDOW_D + 5) * DAY).toISOString();
    const { data: outs } = await ctx.supabase.from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', ctx.workspaceId).in('property', ADVANCE_PROPS)
      .gte('observed_at', sinceEvents).order('observed_at', { ascending: true }).limit(20000);
    const outsByEntity = new Map();
    for (const o of outs ?? []) { if (!entityIds.has(o.entity_id)) continue; (outsByEntity.get(o.entity_id) ?? outsByEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }

    // 4. Aggregate: for each behavior, advance-rate when we did the RIGHT thing vs the
    //    wrong thing. `good` behaviors want true; leaks want false.
    const agg = new Map(BEHAVIORS.map((b) => [b.key, { right: { n: 0, won: 0 }, wrong: { n: 0, won: 0 } }]));
    let won = 0;
    for (const c of labeled) {
      const label = labelById.get(c.id);
      const callMs = new Date(c.at).getTime();
      const advanced = (outsByEntity.get(c.entityId) ?? []).some((o) => {
        const t = new Date(o.observed_at).getTime();
        return t > callMs && t <= callMs + OUTCOME_WINDOW_D * DAY;
      });
      if (advanced) won += 1;
      for (const b of BEHAVIORS) {
        const did = label[b.key] === true;
        const isRight = did === b.good;                 // did the good thing, or avoided the leak
        const cell = agg.get(b.key)[isRight ? 'right' : 'wrong'];
        cell.n += 1; if (advanced) cell.won += 1;
      }
    }
    const overall = round4(won / labeled.length);

    const byBehavior = BEHAVIORS.map((b) => {
      const { right, wrong } = agg.get(b.key);
      const rateRight = right.n ? round4(right.won / right.n) : null;
      const rateWrong = wrong.n ? round4(wrong.won / wrong.n) : null;
      const eligible = right.n >= MIN_BEHAVIOR_N && wrong.n >= MIN_BEHAVIOR_N;
      const lift = eligible ? round4(rateRight - rateWrong) : null;
      return {
        key: b.key, right_phrase: b.good ? b.present : b.absent, wrong_phrase: b.good ? b.absent : b.present,
        n_right: right.n, n_wrong: wrong.n, rate_right: rateRight, rate_wrong: rateWrong, lift, eligible,
      };
    });
    // The lever: the eligible behavior with the biggest positive lift.
    const best = byBehavior.filter((r) => r.eligible && r.lift > 0).sort((a, b) => b.lift - a.lift)[0] ?? null;

    const template = best
      ? `On calls where you ${best.right_phrase}, the deal advanced ${pct(best.rate_right)} of the time, vs ${pct(best.rate_wrong)} when you ${best.wrong_phrase}.`
      : `Across ${labeled.length} calls, ${pct(overall)} advanced — not a clear enough signal yet to name a lever.`;

    return [{
      conditions: {},                     // v2: cut by persona/segment via ri_observations.conditions
      behaviorKey: 'call.behaviors',
      outcomeKey: 'advanced',
      sampleSize: labeled.length,
      effect: best ? best.lift : round4(overall),
      confidence: confidenceForSample(labeled.length),
      recommendationTemplate: template,
      evidence: {
        calls: labeled.length,
        advanced: won,
        overall_rate: overall,
        best_lever: best,
        by_behavior: byBehavior,
      },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'meeting')).find((o) => o.question_key === KEY);
    const best = active?.evidence?.best_lever ?? null;
    if (!best?.key) return [];   // nothing learned worth coaching on yet

    // Recent calls where the winning lever was MISSING — the coaching moment.
    const since = new Date(Date.now() - OUTCOME_WINDOW_D * DAY).toISOString();
    const { data: notes } = await ctx.supabase.from('claims')
      .select('id, entity_id, value, valid_from, computed_at, last_observed_at')
      .eq('workspace_id', ctx.workspaceId).like('property', 'note.%').is('invalid_at', null)
      .gte('last_observed_at', since)
      .order('last_observed_at', { ascending: false }).limit(200);
    const recent = (notes ?? [])
      .filter((n) => n.entity_id && DOC_TYPES.includes(docTypeOf(n)) && contentOf(n).length >= MIN_TRANSCRIPT_CHARS)
      .map((n) => ({ id: n.id, entityId: n.entity_id, at: atOf(n) }));
    if (!recent.length) return [];

    const cached = await getBehaviors(ctx.supabase, ctx.workspaceId, { behaviorKey: BEHAVIOR_KEY, subjectType: 'call' });
    const labelById = new Map();
    for (const r of cached) { try { labelById.set(r.subject_id, JSON.parse(r.value_text)); } catch { /* skip */ } }
    const bdef = BEHAVIORS.find((b) => b.key === best.key);
    if (!bdef) return [];

    // Latest call per entity that missed the lever.
    const latestMissing = new Map();
    for (const c of recent) {
      const label = labelById.get(c.id);
      if (!label) continue;
      const isRight = (label[best.key] === true) === bdef.good;
      if (isRight) continue;                              // did the right thing — no coaching
      if (!latestMissing.has(c.entityId)) latestMissing.set(c.entityId, c);
    }
    if (!latestMissing.size) return [];

    const entityIds = [...latestMissing.keys()];
    const { data: cs } = await ctx.supabase.from('contacts').select('id, company_id').in('id', entityIds);
    const companyOf = new Map((cs ?? []).map((c) => [c.id, c.company_id]));

    const out = [];
    const seen = new Set();
    for (const [entityId, call] of latestMissing) {
      // Already advanced since the call → no coaching needed.
      const { data: adv } = await ctx.supabase.from('observations')
        .select('id').eq('workspace_id', ctx.workspaceId).eq('entity_id', entityId)
        .in('property', ADVANCE_PROPS).gt('observed_at', call.at).limit(1);
      if (adv?.length) continue;

      const target = companyOf.get(entityId) || entityId;
      if (seen.has(target)) continue;
      seen.add(target);

      out.push({
        category: 'meeting', recKey: KEY,
        targetType: 'deal', targetId: target,
        observationId: active?.id ?? null,
        text: `On your last call here you ${best.wrong_phrase}. Your calls advance ${pct(best.rate_right)} when you ${best.right_phrase} vs ${pct(best.rate_wrong)} when you don't — do it now.`,
        evidence: { lever: best.key, right_phrase: best.right_phrase, rate_right: best.rate_right, rate_wrong: best.rate_wrong, call_id: call.id },
      });
      if (out.length >= 25) break;
    }
    return out;
  },
};
