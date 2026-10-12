// Extractor + job: outbound intelligence. The first GENERAL recs — not tied to one
// account (they target a campaign), so they land in the general bucket, not an
// account group.
//
// Behavior: per-campaign reply and opportunity rate. Job: flag sequences that get
// replies but don't convert, or reply well below the workspace's own median. The
// baseline is the workspace's own reply-rate distribution — honest, no external norm.

import { listCampaigns } from '../campaigns.mjs';
import { getActiveObservations } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.underperformer';
const MIN_CONTACTED = 300;          // below this the rate is too noisy to judge
const MIN_CAMPAIGNS = 2;            // need at least this many sequences with data to compare one against the rest
const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const providerName = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'outbound');
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Behavior extractor ───────────────────────────────────────────────────────
export const campaignPerformance = {
  key: 'campaign.performance',
  version: 1,
  subjectType: 'campaign',
  async extract(ctx) {
    const camps = await listCampaigns(ctx.supabase, ctx.workspaceId);
    const out = [];
    for (const c of camps) {
      if (c.replyRate != null) out.push({ key: 'campaign.reply_rate', subjectType: 'campaign', subjectId: c.campaignId, valueNum: c.replyRate });
      if (c.oppRate != null) out.push({ key: 'campaign.opportunity_rate', subjectType: 'campaign', subjectId: c.campaignId, valueNum: c.oppRate });
    }
    return out;
  },
};

// ── Learning job ─────────────────────────────────────────────────────────────
export const outboundUnderperformer = {
  key: KEY,
  category: 'outbound',
  type: 'comparative',
  cadence: 'nightly',
  question: 'Which sequences get replies but do not convert, or reply below our own median?',

  async learn(ctx) {
    // Cold-email sequences are start-stop batches, so we compare across ALL sequences
    // with enough volume, not just the ones sending right now — the useful signal is
    // "your recent send underperformed, fix the next one". The median is the baseline.
    const camps = (await listCampaigns(ctx.supabase, ctx.workspaceId))
      .filter((c) => c.contacted >= MIN_CONTACTED && c.replyRate != null);
    if (camps.length < MIN_CAMPAIGNS) return [];
    const med = median(camps.map((c) => c.replyRate));
    return [{
      conditions: {}, behaviorKey: 'campaign.reply_rate', outcomeKey: 'opportunity',
      sampleSize: camps.length, effect: round4(med), confidence: confidenceForSample(camps.length),
      recommendationTemplate: `Median reply rate across your sequences is ${pct(med)}.`,
      evidence: { campaigns: camps.length, median_reply_rate: round4(med) },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'outbound')).find((o) => o.question_key === KEY);
    const observationId = active?.id ?? null;

    // Same set as learn: every sequence with enough volume, median as baseline.
    const camps = (await listCampaigns(ctx.supabase, ctx.workspaceId))
      .filter((c) => c.contacted >= MIN_CONTACTED);
    if (camps.length < MIN_CAMPAIGNS) return [];
    const med = median(camps.filter((c) => c.replyRate != null).map((c) => c.replyRate));

    const out = [];
    for (const c of camps) {
      const prov = providerName(c.provider);
      let text = null, evidence = null;
      // Forward-looking — "fix the next send", not "un-pause this one". A batch that
      // already ran is still the best evidence for what to change next time.
      if (c.opportunities === 0 && c.replies >= 5) {
        text = `Optimize your next ${prov} sequence — "${c.name}" got ${c.replies} replies but 0 opportunities on ${c.contacted.toLocaleString()} contacted. The messaging earns responses, not meetings.`;
        evidence = { provider: c.provider, campaign_name: c.name, replies: c.replies, opportunities: 0, contacted: c.contacted };
      } else if (med != null && c.replyRate != null && c.replyRate < med * 0.5) {
        text = `Optimize your next ${prov} sequence — "${c.name}" replied ${pct(c.replyRate)} on ${c.contacted.toLocaleString()} contacted, well below your ${pct(med)} median.`;
        evidence = { provider: c.provider, campaign_name: c.name, reply_rate: round4(c.replyRate), median: round4(med), contacted: c.contacted };
      }
      if (text) out.push({ category: 'outbound', recKey: KEY, targetType: 'campaign', targetId: c.campaignId, observationId, text, evidence });
    }
    return out;
  },
};
