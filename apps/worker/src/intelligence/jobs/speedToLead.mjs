// Speed-to-lead — the flagship trace-driven learning job. It learns, from the
// operator's OWN history, whether responding faster to a reply books more meetings:
// pair each inbound reply to our first response after it, measure the response latency,
// and see whether a meeting followed. Then it surfaces the live move — replies still
// sitting unanswered — as "respond now" recommendations, carrying the learned number.
//
// This is the difference the decision trace unlocks: the engine learns about OUR
// behavior (how fast we act), not just the deal's attributes.

import { getActiveObservations } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.speed_to_lead';
const REPLY_PROPS = ['interaction.email_received', 'interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply'];
const RESPONSE_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent'];
const MEETING_PROPS = ['interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const DAY = 86_400_000;
const RESPONSE_WINDOW_D = 7;   // a response after this long isn't really answering that reply
const MEETING_WINDOW_D = 30;   // a meeting this far past the response counts as the outcome
const FAST_MIN = 15;           // the "fast" threshold, in minutes
const LEARN_LOOKBACK_D = 90;
const MIN_PAIRS = 8;
const UNANSWERED_LOOKBACK_D = 5;   // a reply within this window that we haven't answered yet

const round4 = (n) => Math.round(n * 10000) / 10000;
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => `${(n * 100).toFixed(0)}%`;

export const speedToLead = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Does responding faster to a reply book more meetings?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const { data: obs } = await ctx.supabase.from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', ctx.workspaceId)
      .in('property', [...REPLY_PROPS, ...RESPONSE_PROPS, ...MEETING_PROPS])
      .gte('observed_at', since)
      .order('observed_at', { ascending: true })
      .limit(20000);

    // Group each entity's events (already time-ordered) and pair reply → our response.
    const byEntity = new Map();
    for (const o of obs ?? []) {
      if (!o.entity_id) continue;
      (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o);
    }
    const pairs = [];   // { latencyMin, booked }
    for (const events of byEntity.values()) {
      for (let i = 0; i < events.length; i++) {
        if (!REPLY_PROPS.includes(events[i].property)) continue;
        const replyT = new Date(events[i].observed_at).getTime();
        // our first response after this reply, inside the window
        const resp = events.slice(i + 1).find((x) =>
          RESPONSE_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= replyT + RESPONSE_WINDOW_D * DAY);
        if (!resp) continue;
        const respT = new Date(resp.observed_at).getTime();
        // a meeting after our response, inside the window → the outcome
        const booked = events.some((x) =>
          MEETING_PROPS.includes(x.property) &&
          new Date(x.observed_at).getTime() > respT &&
          new Date(x.observed_at).getTime() <= respT + MEETING_WINDOW_D * DAY);
        pairs.push({ latencyMin: (respT - replyT) / 60000, booked });
      }
    }
    if (pairs.length < MIN_PAIRS) return [];

    const fast = pairs.filter((p) => p.latencyMin <= FAST_MIN);
    const slow = pairs.filter((p) => p.latencyMin > FAST_MIN);
    const rate = (arr) => (arr.length ? arr.filter((p) => p.booked).length / arr.length : 0);
    const fastRate = rate(fast), slowRate = rate(slow);
    const lift = slowRate > 0 ? round1(fastRate / slowRate) : null;

    return [{
      conditions: { threshold_min: FAST_MIN },
      behaviorKey: 'response.latency',
      outcomeKey: 'meeting_booked',
      sampleSize: pairs.length,
      effect: round4(fastRate - slowRate),
      confidence: confidenceForSample(pairs.length),
      recommendationTemplate: `Replies you answered within ${FAST_MIN} min booked a meeting ${pct(fastRate)} of the time, vs ${pct(slowRate)} when answered later.`,
      evidence: { pairs: pairs.length, fast_n: fast.length, slow_n: slow.length, fast_rate: round4(fastRate), slow_rate: round4(slowRate), lift },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'outbound')).find((o) => o.question_key === KEY);
    const ev = active?.evidence ?? null;
    const lift = ev?.lift;

    // Recent inbound replies with no response yet — the live speed-to-lead move.
    const since = new Date(Date.now() - UNANSWERED_LOOKBACK_D * DAY).toISOString();
    const { data: replies } = await ctx.supabase.from('observations')
      .select('entity_id, observed_at')
      .eq('workspace_id', ctx.workspaceId).in('property', REPLY_PROPS)
      .gte('observed_at', since)
      .order('observed_at', { ascending: false })
      .limit(500);

    // Most-recent reply per entity.
    const latestReply = new Map();
    for (const r of replies ?? []) if (r.entity_id && !latestReply.has(r.entity_id)) latestReply.set(r.entity_id, r.observed_at);
    if (!latestReply.size) return [];

    // Resolve each replier to its company so the rec groups as an account.
    const entityIds = [...latestReply.keys()];
    const { data: cs } = await ctx.supabase.from('contacts').select('id, company_id').in('id', entityIds);
    const companyOf = new Map((cs ?? []).map((c) => [c.id, c.company_id]));

    const out = [];
    for (const [entityId, replyAt] of latestReply) {
      // Skip if we've already responded after that reply.
      const { data: resp } = await ctx.supabase.from('observations')
        .select('id').eq('workspace_id', ctx.workspaceId).eq('entity_id', entityId)
        .in('property', RESPONSE_PROPS).gt('observed_at', replyAt).limit(1);
      if (resp?.length) continue;

      const target = companyOf.get(entityId) || entityId;
      const why = lift ? ` Replies answered fast book ${lift}x more meetings here.` : ' Fast replies book far more meetings.';
      out.push({
        category: 'outbound', recKey: KEY,
        targetType: 'deal', targetId: target,
        observationId: active?.id ?? null,
        text: `A reply is sitting unanswered — respond now.${why}`,
        evidence: { reply_at: replyAt, lift: lift ?? null },
      });
    }
    return out;
  },
};
