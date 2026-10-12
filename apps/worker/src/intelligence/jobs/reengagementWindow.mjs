// Re-engagement window — learns how long a quiet account stays revivable. It finds
// every time we broke a silence (an outbound touch after a real gap of no activity),
// measures how many days the account had been quiet, and whether the touch revived it
// (a reply or a meeting followed). Then it learns the window where revival still works
// and where it collapses — so a quiet deal isn't "re-engage someday" but "re-engage
// now, the window closes in N days."
//
// A structured trace job — same interaction stream as speed-to-lead, no LLM. It turns
// the deterministic cooling/stall flags into a learned deadline.

import { getActiveObservations } from '../db.mjs';
import { listDeals } from '../deals.mjs';
import { confidenceForSample } from '../types.mjs';

const KEY = 'leakage.reengagement_window';
const SEND_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent', 'interaction.linkedin_invite_sent'];
const POSITIVE_PROPS = ['interaction.email_received', 'interaction.reply', 'interaction.email_reply', 'interaction.outbound_positive_reply',
  'interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const ACTIVITY_PROPS = [...new Set([...SEND_PROPS, ...POSITIVE_PROPS])];
const DAY = 86_400_000;
const LEARN_LOOKBACK_D = 365;
const SILENCE_MIN_D = 21;       // a gap this long before our touch = a re-engagement attempt
const REVIVE_WINDOW_D = 21;     // a positive response this soon after = revived
const THRESHOLD_D = 45;         // the near/far split we learn the revival rate across
const MIN_ATTEMPTS = 8;

const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;
const gapBucket = (d) => (d < 30 ? '<30d' : d < 60 ? '30-60d' : d < 90 ? '60-90d' : '90d+');

async function loadActivity(ctx, sinceIso) {
  const { data: obs } = await ctx.supabase.from('observations')
    .select('entity_id, property, observed_at')
    .eq('workspace_id', ctx.workspaceId).in('property', ACTIVITY_PROPS)
    .gte('observed_at', sinceIso).order('observed_at', { ascending: true }).limit(20000);
  const byEntity = new Map();
  for (const o of obs ?? []) { if (!o.entity_id) continue; (byEntity.get(o.entity_id) ?? byEntity.set(o.entity_id, []).get(o.entity_id)).push(o); }
  return byEntity;
}

export const reengagementWindow = {
  key: KEY,
  category: 'leakage',
  type: 'correlational',
  cadence: 'weekly',
  question: 'How long after a deal goes quiet can we still revive it?',

  async learn(ctx) {
    const since = new Date(Date.now() - LEARN_LOOKBACK_D * DAY).toISOString();
    const byEntity = await loadActivity(ctx, since);

    const attempts = [];   // { gapDays, revived }
    for (const events of byEntity.values()) {
      for (let i = 1; i < events.length; i++) {   // i=1: needs a prior event to measure silence
        if (!SEND_PROPS.includes(events[i].property)) continue;
        const sendT = new Date(events[i].observed_at).getTime();
        const prevT = new Date(events[i - 1].observed_at).getTime();
        const gapDays = (sendT - prevT) / DAY;
        if (gapDays < SILENCE_MIN_D) continue;   // not a silence-breaking touch (dedupes back-to-back sends)
        const revived = events.slice(i + 1).some((x) =>
          POSITIVE_PROPS.includes(x.property) && new Date(x.observed_at).getTime() <= sendT + REVIVE_WINDOW_D * DAY);
        attempts.push({ gapDays, revived });
      }
    }
    if (attempts.length < MIN_ATTEMPTS) return [];

    const rate = (arr) => (arr.length ? arr.filter((a) => a.revived).length / arr.length : 0);
    const near = attempts.filter((a) => a.gapDays <= THRESHOLD_D);
    const far = attempts.filter((a) => a.gapDays > THRESHOLD_D);
    const nearRate = rate(near), farRate = rate(far);

    const byBucket = new Map();
    const bump = (k, won) => { const v = byBucket.get(k) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; byBucket.set(k, v); };
    for (const a of attempts) bump(gapBucket(a.gapDays), a.revived);
    const order = { '<30d': 0, '30-60d': 1, '60-90d': 2, '90d+': 3 };
    const buckets = [...byBucket].map(([bucket, v]) => ({ bucket, n: v.n, won: v.won, rate: round4(v.won / v.n) }))
      .sort((a, b) => order[a.bucket] - order[b.bucket]);

    const template = `Quiet accounts you re-engaged within ${THRESHOLD_D} days revived ${pct(nearRate)} of the time, vs ${pct(farRate)} after.`;

    return [{
      conditions: { threshold_d: THRESHOLD_D },
      behaviorKey: 'reengagement.gap',
      outcomeKey: 'revived',
      sampleSize: attempts.length,
      effect: round4(nearRate - farRate),
      confidence: confidenceForSample(attempts.length),
      recommendationTemplate: template,
      evidence: { attempts: attempts.length, threshold_d: THRESHOLD_D, near_n: near.length, far_n: far.length, near_rate: round4(nearRate), far_rate: round4(farRate), by_gap: buckets },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'leakage')).find((o) => o.question_key === KEY);
    const ev = active?.evidence ?? null;
    if (!ev) return [];
    const threshold = ev.threshold_d ?? THRESHOLD_D;

    const openCompanies = new Set((await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen).map((d) => d.id));
    if (!openCompanies.size) return [];

    // Accounts sitting inside the still-revivable window: quiet, but not yet past the cliff.
    const since = new Date(Date.now() - (threshold + 30) * DAY).toISOString();
    const byEntity = await loadActivity(ctx, since);
    const now = Date.now();
    const entityIds = [...byEntity.keys()];
    const { data: cs } = await ctx.supabase.from('contacts').select('id, company_id').in('id', entityIds);
    const companyOf = new Map((cs ?? []).map((c) => [c.id, c.company_id]));

    // Latest activity per company (a deal is quiet by its most recent touch across contacts).
    const lastByCompany = new Map();
    for (const [entityId, events] of byEntity) {
      const company = companyOf.get(entityId);
      if (!company || !openCompanies.has(company)) continue;
      const last = new Date(events[events.length - 1].observed_at).getTime();
      if (!lastByCompany.has(company) || last > lastByCompany.get(company)) lastByCompany.set(company, last);
    }

    const candidates = [];
    for (const [company, last] of lastByCompany) {
      const daysQuiet = Math.floor((now - last) / DAY);
      if (daysQuiet < SILENCE_MIN_D || daysQuiet > threshold) continue;   // active, or already past the window
      candidates.push({ company, daysQuiet });
    }
    // Closest to the cliff first — those are the most urgent.
    candidates.sort((a, b) => b.daysQuiet - a.daysQuiet);

    return candidates.slice(0, 25).map(({ company, daysQuiet }) => ({
      category: 'leakage', recKey: KEY, targetType: 'deal', targetId: company,
      observationId: active?.id ?? null,
      text: `Quiet ${daysQuiet} days. Re-engaging within ~${threshold}d revived ${pct(ev.near_rate ?? 0)} of deals here — reach out before the window closes.`,
      evidence: { days_quiet: daysQuiet, threshold_d: threshold, near_rate: ev.near_rate ?? null },
    }));
  },
};
