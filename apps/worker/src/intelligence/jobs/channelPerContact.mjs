// Channel effectiveness — learns which channel actually gets a response, so the Draft
// default stops being "always email." For every outbound touch it checks whether a
// positive response (a reply or a meeting) followed inside the window, then compares the
// conversion rate of email vs LinkedIn from the operator's OWN history.
//
// A structured trace job — no LLM. Learn-only for now; the number is knowledge the Draft
// channel picker can lean on.

import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.channel_effectiveness';
const SEND_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent'];
const POSITIVE_PROPS = ['interaction.email_received', 'interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply',
  'interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const DAY = 86_400_000;
const LEARN_LOOKBACK_D = 120;
const RESPOND_WINDOW_D = 10;   // a positive response this soon after a send = that send worked
const MIN_SENDS = 8;

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const channelOf = (prop) => (String(prop).includes('linkedin') ? 'linkedin' : 'email');

export const channelEffectiveness = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Which channel gets a response more often — email or LinkedIn?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const { data: obs } = await ctx.supabase.from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', ctx.workspaceId).in('property', [...SEND_PROPS, ...POSITIVE_PROPS])
      .gte('observed_at', since).order('observed_at', { ascending: true }).limit(20000);
    const byEntity = new Map();
    for (const o of obs ?? []) { if (!o.entity_id) continue; (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }

    const byChannel = new Map();   // channel -> { n, won }
    const bump = (k, won) => { const v = byChannel.get(k) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; byChannel.set(k, v); };
    let total = 0;
    for (const events of byEntity.values()) {
      for (let i = 0; i < events.length; i++) {
        if (!SEND_PROPS.includes(events[i].property)) continue;
        const sendT = new Date(events[i].observed_at).getTime();
        const responded = events.slice(i + 1).some((x) =>
          POSITIVE_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= sendT + RESPOND_WINDOW_D * DAY);
        bump(channelOf(events[i].property), responded);
        total += 1;
      }
    }
    if (total < MIN_SENDS) return [];

    const channels = [...byChannel].map(([channel, v]) => ({ channel, n: v.n, won: v.won, rate: round4(v.won / v.n) }))
      .filter((c) => c.n >= 2).sort((a, b) => b.rate - a.rate);
    if (!channels.length) return [];
    const best = channels[0];
    const overall = round4([...byChannel.values()].reduce((s, v) => s + v.won, 0) / total);
    const template = channels.length > 1
      ? `Your ${best.channel} touches got a response ${pct(best.rate)} of the time, vs ${pct(channels[1].rate)} for ${channels[1].channel}.`
      : `Your ${best.channel} touches got a response ${pct(best.rate)} of the time.`;

    return [{
      conditions: { respond_window_d: RESPOND_WINDOW_D },
      behaviorKey: 'send.channel',
      outcomeKey: 'responded',
      sampleSize: total,
      effect: channels.length > 1 ? round4(best.rate - channels[1].rate) : round4(best.rate),
      confidence: confidenceForSample(total),
      recommendationTemplate: template,
      evidence: { sends: total, overall_rate: overall, best_channel: best.channel, by_channel: channels },
    }];
  },
  // No recommend() — this is knowledge about which channel converts, surfaced as a
  // summary and (later) a Draft-channel default, not a per-account action.
};
