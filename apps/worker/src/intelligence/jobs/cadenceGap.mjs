// Cadence gap — learns the spacing that gets replies. For each follow-up we send (a
// touch that had an earlier touch of ours to the same person), it measures the gap since
// our last touch and whether a reply landed soon after, then compares tight vs loose
// spacing from the operator's OWN history. Answers "how long should I wait before the
// next touch."
//
// A structured trace job — no LLM. Learn-only for now.

import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.cadence_gap';
const SEND_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent'];
const REPLY_PROPS = ['interaction.email_received', 'interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply'];
const DAY = 86_400_000;
const LEARN_LOOKBACK_D = 120;
const REPLY_WINDOW_D = 7;      // a reply this soon after the touch = that touch landed
const THRESHOLD_D = 5;         // the tight/loose split we learn the reply rate across
const MIN_TOUCHES = 8;

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const gapBucket = (d) => (d <= 2 ? '<=2d' : d <= 5 ? '3-5d' : d <= 9 ? '6-9d' : '10d+');

export const cadenceGap = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'What spacing between touches gets a reply?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const { data: obs } = await ctx.supabase.from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', ctx.workspaceId).in('property', [...SEND_PROPS, ...REPLY_PROPS])
      .gte('observed_at', since).order('observed_at', { ascending: true }).limit(20000);
    const byEntity = new Map();
    for (const o of obs ?? []) { if (!o.entity_id) continue; (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }

    const touches = [];   // { gapDays, replied }
    for (const events of byEntity.values()) {
      let lastSendT = null;
      for (let i = 0; i < events.length; i++) {
        if (!SEND_PROPS.includes(events[i].property)) continue;
        const sendT = new Date(events[i].observed_at).getTime();
        if (lastSendT != null) {
          const gapDays = (sendT - lastSendT) / DAY;
          if (gapDays >= 0) {
            const replied = events.slice(i + 1).some((x) =>
              REPLY_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= sendT + REPLY_WINDOW_D * DAY);
            touches.push({ gapDays, replied });
          }
        }
        lastSendT = sendT;
      }
    }
    if (touches.length < MIN_TOUCHES) return [];

    const rate = (arr) => (arr.length ? arr.filter((t) => t.replied).length / arr.length : 0);
    const tight = touches.filter((t) => t.gapDays <= THRESHOLD_D);
    const loose = touches.filter((t) => t.gapDays > THRESHOLD_D);
    const tightRate = rate(tight), looseRate = rate(loose);

    const byBucket = new Map();
    const bump = (k, won) => { const v = byBucket.get(k) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; byBucket.set(k, v); };
    for (const t of touches) bump(gapBucket(t.gapDays), t.replied);
    const order = { '<=2d': 0, '3-5d': 1, '6-9d': 2, '10d+': 3 };
    const buckets = [...byBucket].map(([bucket, v]) => ({ bucket, n: v.n, won: v.won, rate: round4(v.won / v.n) }))
      .sort((a, b) => order[a.bucket] - order[b.bucket]);

    const template = `Follow-ups you sent within ${THRESHOLD_D} days of your last touch got a reply ${pct(tightRate)} of the time, vs ${pct(looseRate)} when you waited longer.`;

    return [{
      conditions: { threshold_d: THRESHOLD_D, reply_window_d: REPLY_WINDOW_D },
      behaviorKey: 'touch.gap',
      outcomeKey: 'replied',
      sampleSize: touches.length,
      effect: round4(tightRate - looseRate),
      confidence: confidenceForSample(touches.length),
      recommendationTemplate: template,
      evidence: { touches: touches.length, threshold_d: THRESHOLD_D, tight_n: tight.length, loose_n: loose.length, tight_rate: round4(tightRate), loose_rate: round4(looseRate), by_gap: buckets },
    }];
  },
  // No recommend() — this is spacing knowledge, surfaced as a summary; the per-account
  // "you're overdue for a touch" nudge is follow-up persistence's lane.
};
