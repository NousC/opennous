// Follow-up persistence — learns, from the operator's OWN history, whether following
// up more after a reply books more meetings. For each inbound reply it counts how many
// times we followed up and whether a meeting followed, then compares single-touch to
// multi-touch booking rates. The live move it surfaces is the opposite of speed-to-lead:
// not "you never answered" but "you answered once and then went quiet."
//
// A structured trace job — same reply/send/meeting signal as speed-to-lead, no LLM.

import { getActiveObservations } from '../db.mjs';
import { listDeals } from '../deals.mjs';
import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.follow_up_persistence';
const REPLY_PROPS = ['interaction.email_received', 'interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply'];
const RESPONSE_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent'];
const MEETING_PROPS = ['interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const DAY = 86_400_000;
const LEARN_LOOKBACK_D = 120;
const FOLLOWUP_WINDOW_D = 30;   // our sends this long after the reply count as follow-ups
const BOOK_WINDOW_D = 45;       // a meeting this long after the reply is the outcome
const MIN_PAIRS = 8;
const RECENT_REPLY_D = 21;      // recommend: a reply we engaged this recently
const QUIET_AFTER_D = 4;        // ...but haven't touched again in this long

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const bucketOf = (c) => (c >= 3 ? '3+' : String(c));

// Pull the reply/send/meeting stream once and group by entity, time-ordered — the
// speed-to-lead read pattern (never a huge entity .in()).
async function loadStream(ctx, sinceIso) {
  const { data: obs } = await ctx.supabase.from('observations')
    .select('entity_id, property, observed_at')
    .eq('workspace_id', ctx.workspaceId)
    .in('property', [...REPLY_PROPS, ...RESPONSE_PROPS, ...MEETING_PROPS])
    .gte('observed_at', sinceIso).order('observed_at', { ascending: true }).limit(20000);
  const byEntity = new Map();
  for (const o of obs ?? []) { if (!o.entity_id) continue; (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }
  return byEntity;
}

export const followUpPersistence = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Does following up more after a reply book more meetings?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const byEntity = await loadStream(ctx, since);

    const pairs = [];   // { followups, booked }
    for (const events of byEntity.values()) {
      for (let i = 0; i < events.length; i++) {
        if (!REPLY_PROPS.includes(events[i].property)) continue;
        const replyT = new Date(events[i].observed_at).getTime();
        const after = events.slice(i + 1);
        const followups = after.filter((x) =>
          RESPONSE_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= replyT + FOLLOWUP_WINDOW_D * DAY).length;
        if (followups < 1) continue;   // 0 = we never engaged; that is speed-to-lead's lane
        const booked = after.some((x) =>
          MEETING_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= replyT + BOOK_WINDOW_D * DAY);
        pairs.push({ followups, booked });
      }
    }
    if (pairs.length < MIN_PAIRS) return [];

    const byBucket = new Map();   // '1'|'2'|'3+' -> { n, won }
    const bump = (k, won) => { const v = byBucket.get(k) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; byBucket.set(k, v); };
    for (const p of pairs) bump(bucketOf(p.followups), p.booked);

    const rate = (arr) => (arr.length ? arr.filter((p) => p.booked).length / arr.length : 0);
    const oneRate = rate(pairs.filter((p) => p.followups === 1));
    const multiRate = rate(pairs.filter((p) => p.followups >= 2));
    const order = { '1': 0, '2': 1, '3+': 2 };
    const buckets = [...byBucket].map(([bucket, v]) => ({ bucket, n: v.n, won: v.won, rate: round4(v.won / v.n) }))
      .sort((a, b) => order[a.bucket] - order[b.bucket]);
    const bestBucket = [...buckets].filter((b) => b.n >= 2).sort((a, b) => b.rate - a.rate)[0] ?? null;

    const persists = multiRate > oneRate;
    const template = persists
      ? `Deals you followed up on 2+ times after a reply booked ${pct(multiRate)} of the time, vs ${pct(oneRate)} with a single follow-up.`
      : `Following up more after a reply did not lift booking here (${pct(multiRate)} at 2+ vs ${pct(oneRate)} at one).`;

    return [{
      conditions: { followup_window_d: FOLLOWUP_WINDOW_D },
      behaviorKey: 'followup.count',
      outcomeKey: 'meeting_booked',
      sampleSize: pairs.length,
      effect: round4(multiRate - oneRate),
      confidence: confidenceForSample(pairs.length),
      recommendationTemplate: template,
      evidence: { pairs: pairs.length, one_rate: round4(oneRate), multi_rate: round4(multiRate), best_bucket: bestBucket?.bucket ?? null, persists, by_followups: buckets },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'outbound')).find((o) => o.question_key === KEY);
    const ev = active?.evidence ?? null;
    if (!ev?.persists) return [];   // only nudge more touches where more actually books more

    const openCompanies = new Set((await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen).map((d) => d.id));
    if (!openCompanies.size) return [];

    const since = new Date(Date.now() - (RECENT_REPLY_D + FOLLOWUP_WINDOW_D) * DAY).toISOString();
    const byEntity = await loadStream(ctx, since);
    const cutoffRecent = Date.now() - RECENT_REPLY_D * DAY;
    const now = Date.now();

    // Resolve repliers to their company so we group + gate on the deal.
    const entityIds = [...byEntity.keys()];
    const { data: cs } = await ctx.supabase.from('contacts').select('id, company_id').in('id', entityIds);
    const companyOf = new Map((cs ?? []).map((c) => [c.id, c.company_id]));

    const out = [];
    const seen = new Set();
    for (const [entityId, events] of byEntity) {
      // The most recent reply we engaged.
      const replyEvent = [...events].reverse().find((e) => REPLY_PROPS.includes(e.property));
      if (!replyEvent) continue;
      const replyT = new Date(replyEvent.observed_at).getTime();
      if (replyT < cutoffRecent) continue;   // reply too old to be a live moment

      const after = events.filter((e) => new Date(e.observed_at).getTime() > replyT);
      const ourSends = after.filter((e) => RESPONSE_PROPS.includes(e.property));
      if (!ourSends.length) continue;                                   // never answered → speed-to-lead's lane
      if (after.some((e) => MEETING_PROPS.includes(e.property))) continue; // already booked
      const lastTouch = Math.max(...ourSends.map((e) => new Date(e.observed_at).getTime()));
      if (now - lastTouch < QUIET_AFTER_D * DAY) continue;              // we are actively on it

      const company = companyOf.get(entityId);
      if (!company || !openCompanies.has(company) || seen.has(company)) continue;
      seen.add(company);

      const c = ourSends.length;
      const goal = ev.best_bucket && ev.best_bucket !== '1' ? ` Deals that booked here took ${ev.best_bucket} follow-ups.` : '';
      out.push({
        category: 'outbound', recKey: KEY, targetType: 'deal', targetId: company,
        observationId: active?.id ?? null,
        text: `You followed up ${c} time${c === 1 ? '' : 's'} after their reply, then went quiet.${goal} Send another before it stalls.`,
        evidence: { followups: c, last_touch: new Date(lastTouch).toISOString(), multi_rate: ev.multi_rate ?? null },
      });
      if (out.length >= 25) break;
    }
    return out;
  },
};
