// Value-prop resonance — learns which parts of the pitch actually move deals. It reads
// the emails WE sent (full body from the live Gmail poller), has Haiku label which value
// props each one leaned on, and ties them to whether the deal then advanced. Over enough
// emails it learns which angle resonates and which is noise — so the pitch sharpens on
// evidence, not taste.
//
// The content sibling of objection coaching: that one reads our reply to an objection,
// this reads our pitch. Same read-our-own-words move, same trace.

import { getActiveObservations } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';
import { read, keyedArray } from '../../noema/read.mjs';

const KEY = 'outbound.value_prop_resonance';
const SEND_PROPS = ['interaction.email_sent'];
const ADVANCE_PROPS = ['interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply',
  'interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const DAY = 86_400_000;
const LEARN_LOOKBACK_D = 150;
const ADVANCE_WINDOW_D = 30;   // a meeting/positive reply this soon after = the email advanced it
const MIN_EMAILS = 8;
const MAX_EMAILS = 120;
const MIN_BODY_CHARS = 60;
const MIN_PROP_N = 2;          // a prop needs this many uses before we rate it

// The value props we recognise — the model maps each email to zero or more so we can
// count them. Multi-label: one email can lean on several.
const PROPS = ['roi_time_saved', 'unify_integration', 'ease_simplicity', 'social_proof', 'differentiation', 'security_trust', 'price_value'];
const PROP_LABEL = {
  roi_time_saved: 'ROI / time saved', unify_integration: 'unify / integration', ease_simplicity: 'ease / simplicity',
  social_proof: 'social proof', differentiation: 'differentiation', security_trust: 'security / trust', price_value: 'price / value',
};

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const bodyOf = (o) => o?.raw?.body_text || o?.value?.summary || o?.value?.description || '';

const SYSTEM = `You label which value props a GTM operator's outbound email leans on, for a resonance engine. For EACH email, output the value props it actually makes a case for, as a JSON array drawn ONLY from this set: ${PROPS.join(', ')}.
- roi_time_saved: returns, hours saved, efficiency, pipeline won
- unify_integration: one place, connects your stack, no more silos
- ease_simplicity: easy, fast to set up, no work
- social_proof: named customers, results others got, logos
- differentiation: why us vs alternatives / building it yourself
- security_trust: security, privacy, reliability, compliance
- price_value: pricing, cost, worth it, cheaper
Use only props the email genuinely argues; an empty array is fine. Judge only the text. Return ONLY valid JSON: {"labels":[{"i":<index>,"props":["..."]}]}`;

// The answer IS the labels array: an object without one says nothing about any email, so it is an
// unreadable answer rather than an empty one. An empty `labels` stays a real answer. Gate derived
// from the parser, so the two cannot drift (GET-319/GET-320).
const LABELS = keyedArray('labels');

export const valuePropResonance = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Which value props in our outbound actually move deals forward?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const { data: obs } = await ctx.supabase.from('observations')
      .select('entity_id, property, observed_at, raw, value')
      .eq('workspace_id', ctx.workspaceId).in('property', [...SEND_PROPS, ...ADVANCE_PROPS])
      .gte('observed_at', since).order('observed_at', { ascending: true }).limit(20000);
    const byEntity = new Map();
    for (const o of obs ?? []) { if (!o.entity_id) continue; (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }

    const emails = [];   // { body, advanced }
    for (const events of byEntity.values()) {
      for (let i = 0; i < events.length; i++) {
        if (!SEND_PROPS.includes(events[i].property)) continue;
        const body = bodyOf(events[i]);
        if (body.length < MIN_BODY_CHARS) continue;
        const sendT = new Date(events[i].observed_at).getTime();
        const advanced = events.slice(i + 1).some((x) =>
          ADVANCE_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= sendT + ADVANCE_WINDOW_D * DAY);
        emails.push({ body: body.slice(0, 700), advanced });
        if (emails.length >= MAX_EMAILS) break;
      }
      if (emails.length >= MAX_EMAILS) break;
    }
    if (emails.length < MIN_EMAILS) return [];

    // One model pass — which props each email leans on.
    const numbered = emails.map((e, i) => `[${i}] ${e.body}`).join('\n\n');
    const result = await read({
      supabase: ctx.supabase, workspaceId: ctx.workspaceId,
      feature: 'valueprop-resonance',
      meterAs: 'valueprop-resonance',
      accept: LABELS.accept,
      parse: LABELS.parse,
      maxTokens: 3000,
      system: SYSTEM,
      prompt: `EMAILS (index in brackets):\n${numbered}`,
    });
    // Same result either way — nothing learned — but a failed label pass is now a row, not a
    // week that looks indistinguishable from one with too little outbound to learn from (GET-320).
    if (!result.ok) {
      console.warn(`[ri.valuePropResonance] label pass failed: ${result.reason}`);
      return [];
    }
    const labels = result.value;

    // Advance rate per prop = of the emails that used it, how many advanced.
    const byProp = new Map();   // prop -> { n, won }
    const bump = (k, won) => { const v = byProp.get(k) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; byProp.set(k, v); };
    let labelled = 0, advanced = 0;
    for (const l of labels) {
      const e = emails[l?.i];
      if (!e) continue;
      labelled += 1;
      if (e.advanced) advanced += 1;
      const props = [...new Set((Array.isArray(l.props) ? l.props : []).filter((p) => PROPS.includes(p)))];
      for (const p of props) bump(p, e.advanced);
    }
    if (labelled < MIN_EMAILS) return [];

    const overall = round4(advanced / labelled);
    const props = [...byProp].map(([prop, v]) => ({ prop, label: PROP_LABEL[prop] ?? prop, n: v.n, won: v.won, rate: round4(v.won / v.n) }))
      .sort((a, b) => b.rate - a.rate || b.n - a.n);
    const best = props.filter((p) => p.n >= MIN_PROP_N)[0] ?? null;

    const template = best
      ? `Emails where you leaned on ${best.label} advanced ${pct(best.rate)} of the time, vs ${pct(overall)} across all your outbound.`
      : `Across ${labelled} emails, ${pct(overall)} advanced — not enough yet to name a value prop that resonates.`;

    return [{
      conditions: {},
      behaviorKey: 'email.value_prop',
      outcomeKey: 'advanced',
      sampleSize: labelled,
      effect: best ? round4(best.rate - overall) : round4(overall),
      confidence: confidenceForSample(labelled),
      recommendationTemplate: template,
      evidence: { emails: labelled, advanced, overall_rate: overall, best_prop: best?.prop ?? null, best_label: best?.label ?? null, best_rate: best?.rate ?? null, by_prop: props },
    }];
  },
  // No recommend() — resonance is knowledge that sharpens the pitch, surfaced as a
  // summary (and feeds the campaign brief), not a per-account action.
};
