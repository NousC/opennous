// Objection-response coaching — the first learning job that reads OUR OWN sent
// content, not just the buyer's. For every objection an account raised, it finds the
// reply we actually sent, has Haiku categorize HOW we answered (the approach), and ties
// it to whether the deal then advanced (a meeting or positive reply followed). Over
// enough answers it learns which approach converts — so the battlecard stops guessing
// and tells you the response that has actually won this objection.
//
// This is the content counterpart to speed-to-lead: speed-to-lead learns from WHEN we
// act, this learns from WHAT we say. Both ride the same decision→action→outcome trace.

import { filterDerivedForViewer, TEAM_VIEWER } from '@nous/core';
import { getActiveObservations } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';
import { read, keyedArray } from '../../noema/read.mjs';

const KEY = 'objection.response_coaching';
const OBJECTION_CATS = ['objection', 'pain', 'friction'];
const SEND_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent'];
const MEETING_PROPS = ['interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const POS_REPLY_PROPS = ['interaction.outbound_positive_reply', 'interaction.reply', 'interaction.email_reply'];
const DAY = 86_400_000;
const RESPONSE_WINDOW_D = 21;   // our reply within this of the objection is answering it
const OUTCOME_WINDOW_D = 30;    // an advance within this of our reply is the outcome
const LEARN_LOOKBACK_D = 180;   // objections older than this are stale for coaching
const MIN_TRIPLES = 8;          // = engine MIN_SAMPLE; below this the observation stays 'learning' and is never surfaced
const MIN_APPROACH_N = 2;       // an approach needs this many uses before we name it a winner
const MAX_TRIPLES = 150;        // bound the one model pass
const MIN_BODY_CHARS = 40;      // a one-line "thanks!" is not a response to learn from

// The approaches we recognise. The model must map every reply to exactly one so we can
// aggregate — an open vocabulary can't be counted.
const APPROACHES = ['roi_proof', 'social_proof', 'pricing_flexibility', 'feature_demo', 'defer_nurture', 'direct_reframe', 'no_substantive_answer'];
const APPROACH_LABEL = {
  roi_proof: 'ROI / proof', social_proof: 'social proof', pricing_flexibility: 'pricing flexibility',
  feature_demo: 'feature / demo', defer_nurture: 'defer / nurture', direct_reframe: 'direct reframe',
  no_substantive_answer: 'no real answer',
};

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const labelOf = (a) => APPROACH_LABEL[a] ?? a;

const SYSTEM = `You label how a GTM operator answered a buyer objection, for a coaching engine. You get pairs of (the objection the buyer raised, the reply we sent). For EACH pair output two things:
- "theme": the objection theme in 2-4 words, buyer-facing and normalized so the same objection across pairs gets the same theme ("too expensive" and "hard to justify the spend" -> "price / budget").
- "approach": how OUR reply tried to handle it, EXACTLY one of: ${APPROACHES.join(', ')}. Use "no_substantive_answer" when the reply dodged, only acknowledged, or never addressed the objection.

Judge only from the text given, never invent. Return ONLY valid JSON, this exact shape:
{"labels":[{"i":<pair index>,"theme":"<theme>","approach":"<one approach>"}]}`;

// The answer this pass asks for IS the labels array — an object without one tells us nothing about
// any pair, so it is an unreadable answer and not an empty one. `[]` inside it stays a real answer:
// the model read the pairs and matched none of them. The gate is derived from the parser so the two
// cannot drift (GET-319/GET-320); the old one asked only for a { and a } somewhere in the text.
const LABELS = keyedArray('labels');

// The live Gmail poller stores the full outbound body in raw.body_text; logActivity puts
// the snippet in value.summary / value.description (NOT top-level columns).
const bodyOf = (o) => o?.raw?.body_text || o?.value?.summary || o?.value?.description || '';
const objTextOf = (v) => v?.content ?? v?.text ?? v?.summary ?? '';

export const objectionCoaching = {
  key: KEY,
  category: 'objection',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Which way of answering an objection actually advances the deal?',

  async learn(ctx) {
    const sinceObj = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();

    // 1. The objections buyers raised, with who raised each and when.
    const { data: objs } = await ctx.supabase.from('claims')
      .select('entity_id, property, value, last_observed_at, computed_at, supporting_observation_ids')
      .eq('workspace_id', ctx.workspaceId).like('property', 'note.%').is('invalid_at', null)
      .or(OBJECTION_CATS.map((c) => `value->>category.eq.${c}`).join(','))
      .limit(400);
    // Coaching is read by the whole team: built from team-readable objections only (GET-253).
    const objections = (await filterDerivedForViewer(ctx.supabase, ctx.workspaceId, objs ?? [], TEAM_VIEWER))
      .map((o) => ({ entityId: o.entity_id, text: objTextOf(o.value), at: o.last_observed_at || o.computed_at }))
      .filter((o) => o.entityId && o.text && o.at && o.at >= sinceObj);
    if (objections.length < MIN_TRIPLES) return [];

    // 2. Our sends + the outcome signals — read by property for the whole workspace and
    //    group in JS (the speed-to-lead pattern). A per-entity .in() would blow the URL
    //    limit once a workspace has a few hundred objection accounts.
    const entityIds = new Set(objections.map((o) => o.entityId));
    const sinceEvents = new Date(Date.now() - (LEARN_LOOKBACK_D + OUTCOME_WINDOW_D + RESPONSE_WINDOW_D + 5) * DAY).toISOString();
    const [{ data: sends }, { data: outs }] = await Promise.all([
      ctx.supabase.from('observations')
        .select('entity_id, property, observed_at, raw, value')
        .eq('workspace_id', ctx.workspaceId).in('property', SEND_PROPS)
        .gte('observed_at', sinceEvents).order('observed_at', { ascending: true }).limit(20000),
      ctx.supabase.from('observations')
        .select('entity_id, property, observed_at')
        .eq('workspace_id', ctx.workspaceId).in('property', [...MEETING_PROPS, ...POS_REPLY_PROPS])
        .gte('observed_at', sinceEvents).order('observed_at', { ascending: true }).limit(20000),
    ]);
    const sendsByEntity = new Map();
    for (const s of sends ?? []) { if (!entityIds.has(s.entity_id)) continue; (sendsByEntity.get(s.entity_id) ?? sendsByEntity.set(s.entity_id, []).get(s.entity_id)).push(s); }
    const outsByEntity = new Map();
    for (const o of outs ?? []) { if (!entityIds.has(o.entity_id)) continue; (outsByEntity.get(o.entity_id) ?? outsByEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }

    // 3. Pair each objection → our first substantive reply after it → the outcome.
    const triples = [];   // { objection, response, converted }
    for (const obj of objections) {
      const objMs = new Date(obj.at).getTime();
      const reply = (sendsByEntity.get(obj.entityId) ?? []).find((s) => {
        const t = new Date(s.observed_at).getTime();
        return t > objMs && t <= objMs + RESPONSE_WINDOW_D * DAY && bodyOf(s).length >= MIN_BODY_CHARS;
      });
      if (!reply) continue;
      const respMs = new Date(reply.observed_at).getTime();
      const converted = (outsByEntity.get(obj.entityId) ?? []).some((o) => {
        const t = new Date(o.observed_at).getTime();
        return t > respMs && t <= respMs + OUTCOME_WINDOW_D * DAY;
      });
      triples.push({ objection: obj.text.slice(0, 300), response: bodyOf(reply).slice(0, 700), converted });
      if (triples.length >= MAX_TRIPLES) break;
    }
    if (triples.length < MIN_TRIPLES) return [];

    // 4. One model pass — theme + approach for each (objection, our reply) pair.
    const numbered = triples.map((t, i) => `[${i}] OBJECTION: ${t.objection}\n     OUR REPLY: ${t.response}`).join('\n\n');
    const result = await read({
      supabase: ctx.supabase, workspaceId: ctx.workspaceId,
      feature: 'objection-coaching',
      meterAs: 'objection-coaching',
      accept: LABELS.accept,
      parse: LABELS.parse,
      maxTokens: 3000,
      system: SYSTEM,
      prompt: `PAIRS (index in brackets):\n${numbered}`,
    });
    // Still nothing learned this week either way — but a week where the label pass came back
    // unreadable now says so in pipeline_events, instead of looking like a week with too few
    // answered objections to learn from (GET-320).
    if (!result.ok) {
      console.warn(`[ri.objectionCoaching] label pass failed: ${result.reason}`);
      return [];
    }
    const labels = result.value;

    // 5. Aggregate the win rate by approach (and theme×approach for the battlecard).
    const byApproach = new Map();  // approach -> { n, won }
    const byTheme = new Map();     // theme -> Map(approach -> { n, won })
    const bump = (map, key, won) => { const v = map.get(key) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; map.set(key, v); };
    let won = 0, labelled = 0;
    for (const l of labels) {
      const t = triples[l?.i];
      if (!t || !APPROACHES.includes(l.approach)) continue;
      labelled += 1;
      if (t.converted) won += 1;
      bump(byApproach, l.approach, t.converted);
      const theme = String(l.theme ?? 'other').toLowerCase().trim() || 'other';
      if (!byTheme.has(theme)) byTheme.set(theme, new Map());
      bump(byTheme.get(theme), l.approach, t.converted);
    }
    if (labelled < MIN_TRIPLES) return [];

    const approaches = [...byApproach].map(([approach, v]) => ({
      approach, label: labelOf(approach), n: v.n, won: v.won, rate: round4(v.won / v.n),
    })).sort((a, b) => b.rate - a.rate || b.n - a.n);
    // The winner: the highest-converting approach with enough uses to trust, and that
    // beats simply not answering.
    const eligible = approaches.filter((a) => a.n >= MIN_APPROACH_N && a.approach !== 'no_substantive_answer');
    const best = eligible[0] ?? null;
    const overall = round4(won / labelled);

    const themes = [...byTheme].map(([theme, m]) => {
      const rows = [...m].map(([approach, v]) => ({ approach, label: labelOf(approach), n: v.n, won: v.won, rate: round4(v.won / v.n) }))
        .sort((a, b) => b.rate - a.rate || b.n - a.n);
      const w = rows.filter((r) => r.n >= MIN_APPROACH_N && r.approach !== 'no_substantive_answer')[0] ?? rows[0];
      return { theme, best_approach: w?.approach ?? null, best_label: w?.label ?? null, best_rate: w?.rate ?? null, uses: rows.reduce((s, r) => s + r.n, 0), approaches: rows };
    }).sort((a, b) => b.uses - a.uses);

    const template = best
      ? `When you answered objections with ${best.label}, the deal advanced ${pct(best.rate)} of the time, vs ${pct(overall)} across all your answers.`
      : `Across ${labelled} answered objections, ${pct(overall)} advanced — not enough yet to name a winning approach.`;

    return [{
      conditions: {},
      behaviorKey: 'response.approach',
      outcomeKey: 'advanced',
      sampleSize: labelled,
      effect: best ? round4(best.rate - overall) : round4(overall),
      confidence: confidenceForSample(labelled),
      recommendationTemplate: template,
      evidence: {
        answered: labelled,
        advanced: won,
        overall_rate: overall,
        best_approach: best?.approach ?? null,
        best_label: best?.label ?? null,
        best_rate: best?.rate ?? null,
        by_approach: approaches,
        by_theme: themes,
      },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'objection')).find((o) => o.question_key === KEY);
    const ev = active?.evidence ?? null;
    if (!ev?.best_approach) return [];   // nothing learned worth coaching on yet

    // Live accounts with a recent objection we haven't converted — the coaching moment.
    const since = new Date(Date.now() - RESPONSE_WINDOW_D * DAY).toISOString();
    const { data: objs } = await ctx.supabase.from('claims')
      .select('entity_id, property, value, last_observed_at, supporting_observation_ids')
      .eq('workspace_id', ctx.workspaceId).like('property', 'note.%').is('invalid_at', null)
      .or(OBJECTION_CATS.map((c) => `value->>category.eq.${c}`).join(','))
      .gte('last_observed_at', since)
      .order('last_observed_at', { ascending: false }).limit(200)
      .then(async (r) => ({ ...r, data: await filterDerivedForViewer(ctx.supabase, ctx.workspaceId, r.data ?? [], TEAM_VIEWER) }));

    // Most-recent objection per entity.
    const latest = new Map();
    for (const o of objs ?? []) if (o.entity_id && !latest.has(o.entity_id)) latest.set(o.entity_id, { at: o.last_observed_at, text: objTextOf(o.value) });
    if (!latest.size) return [];

    const entityIds = [...latest.keys()];
    const { data: cs } = await ctx.supabase.from('contacts').select('id, company_id').in('id', entityIds);
    const companyOf = new Map((cs ?? []).map((c) => [c.id, c.company_id]));

    const out = [];
    const seen = new Set();
    for (const [entityId, obj] of latest) {
      // Already advanced since the objection → no coaching needed.
      const { data: adv } = await ctx.supabase.from('observations')
        .select('id').eq('workspace_id', ctx.workspaceId).eq('entity_id', entityId)
        .in('property', [...MEETING_PROPS, ...POS_REPLY_PROPS]).gt('observed_at', obj.at).limit(1);
      if (adv?.length) continue;

      const target = companyOf.get(entityId) || entityId;
      if (seen.has(target)) continue;
      seen.add(target);

      const label = ev.best_label, rate = ev.best_rate;
      const snippet = (obj.text || '').replace(/\s+/g, ' ').slice(0, 90);
      out.push({
        category: 'objection', recKey: KEY,
        targetType: 'deal', targetId: target,
        observationId: active?.id ?? null,
        text: `This account raised an objection${snippet ? ` ("${snippet}")` : ''} you haven't answered. Your ${label} response has converted best here${rate != null ? ` (${pct(rate)})` : ''} — lead with that.`,
        evidence: { objection: obj.text?.slice(0, 300) ?? null, best_approach: ev.best_approach, best_label: label, best_rate: rate },
      });
      if (out.length >= 25) break;
    }
    return out;
  },
};
