// Pipeline-engagement features — *how the deal went*, not just who they are.
//
// Turns an account's activity log into bucketed, discovery-mineable features:
// lead source / channel, inbound-vs-outbound, whether they replied, and banded
// meeting/touch counts. These flow into the feature_snapshot at scoring time
// (predictions.ts) AND into closed-deal episodes (closed-deals import), so the
// Mind can learn signals like "inbound-website converts 3×" or "deals that took
// ≥3 meetings convert less". Pure — no DB, deterministic. See docs/icp-rich-model.md §3C.

export interface PipelineActivity {
  property: string;            // e.g. 'interaction.meeting_held'
  source?: string | null;      // e.g. 'gmail' | 'heyreach' | 'website'
  observed_at: string;
}

// Outcome markers are NOT engagement — exclude them from the counts/first-touch.
const OUTCOME_TYPES = new Set(['deal_won', 'deal_lost', 'deal_disqualified']);

const typeOf = (p: string) => (p || '').replace(/^interaction\./, '');

function channelOf(t: string, s: string): string {
  if (t.includes('linkedin') || s.includes('linkedin') || s === 'heyreach' || s === 'unipile') return 'linkedin';
  if (t.includes('email') || s === 'gmail' || s === 'instantly') return 'email';
  if (t.includes('meeting') || t.includes('call')) return 'meeting';
  if (s.includes('slack')) return 'slack';
  if (t.includes('website') || t.includes('signed_up') || t.includes('subscription') ||
      s.includes('website') || s.includes('stripe') || s.includes('webhook')) return 'website';
  return 'other';
}

// First-touch types/sources that mean the buyer came to us (inbound) vs we
// reached out (outbound).
const INBOUND_TYPES = [
  'website_visit', 'website_revisit', 'signed_up', 'content_download',
  'email_received', 'email_reply', 'linkedin_message_received',
  'subscription_started', 'subscription_updated',
];

export function pipelineFeatures(activities: PipelineActivity[]): Record<string, unknown> {
  const acts = (activities || []).filter(a => !OUTCOME_TYPES.has(typeOf(a.property)));
  if (!acts.length) return {};
  const sorted = [...acts].sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));

  const first = sorted[0];
  const ft = typeOf(first.property);
  const src = String(first.source || '').toLowerCase();
  const channel = channelOf(ft, src);
  const inbound = INBOUND_TYPES.some(x => ft.includes(x)) ||
    ['website', 'stripe', 'webhook', 'self_serve'].some(x => src.includes(x));

  const count = (pred: (t: string) => boolean) => sorted.filter(e => pred(typeOf(e.property))).length;
  const nMeetings = count(t => t.includes('meeting') || t.includes('call'));
  const nTouches = sorted.length;
  const replied = sorted.some(e => {
    const t = typeOf(e.property);
    return t.includes('reply') || t.includes('replied') || t === 'email_received';
  });

  const meetingsBand = nMeetings === 0 ? '0' : nMeetings === 1 ? '1' : nMeetings === 2 ? '2' : '3+';
  const touchesBand = nTouches <= 2 ? '1-2' : nTouches <= 5 ? '3-5' : nTouches <= 10 ? '6-10' : '10+';

  return {
    'pipe.lead_source': `${inbound ? 'inbound' : 'outbound'}_${channel}`,
    'pipe.channel': channel,
    'pipe.inbound': inbound,
    'pipe.replied': replied,
    'pipe.meetings_band': meetingsBand,
    'pipe.touches_band': touchesBand,
  };
}
