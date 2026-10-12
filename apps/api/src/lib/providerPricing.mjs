// Per-record cost of the BYOK data providers, so enrich/verify previews can
// quote real money instead of opaque "credits". Ranges are USD per processed
// record (low = high-volume tier, high = entry tier), June 2026 public pricing.
// These are the CUSTOMER's own cost (we run on their key) — we surface them only
// so the agent can transparently say "this run will cost you ~$X".
//
// Sources: prospeo.io/pricing, apollo.io/pricing, neverbounce.com/pricing,
// millionverifier.com (only charged for good/bad — catch-all/unknown are free).
export const PROVIDER_PRICING = {
  prospeo:         { low: 0.010,  high: 0.039,  label: 'Prospeo',         action: 'email found' },
  apollo:          { low: 0.020,  high: 0.025,  label: 'Apollo',          action: 'email revealed' },
  findymail:       { low: 0.020,  high: 0.049,  label: 'Findymail',       action: 'email found' },
  millionverifier: { low: 0.0004, high: 0.0037, label: 'MillionVerifier', action: 'email verified' },
  neverbounce:     { low: 0.003,  high: 0.008,  label: 'NeverBounce',     action: 'email verified' },
};

const round = (n) => Math.round(n * 100) / 100;

// Cost estimate for `count` records via `provider`. null for unknown provider or
// a zero count (nothing to charge for).
export function estimateCost(provider, count) {
  const p = PROVIDER_PRICING[provider];
  if (!p || !count || count < 0) return null;
  return {
    provider,
    label: p.label,
    action: p.action,
    count,
    currency: 'USD',
    low: round(p.low * count),
    high: round(p.high * count),
    per_record: { low: p.low, high: p.high },
  };
}

// A short human line for an estimate, e.g. "~$23–$90 (Prospeo, 2,300 emails found)".
export function describeCost(est) {
  if (!est) return 'no chargeable records — nothing to spend';
  const lo = est.low.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hi = est.high.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = est.low === est.high ? `~$${lo}` : `~$${lo}–$${hi}`;
  return `${money} (${est.label}, ${est.count.toLocaleString()} ${est.action})`;
}
