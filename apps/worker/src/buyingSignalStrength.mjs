// Tier a buying_signal by its content.
//
// STRONG = an explicit commitment to buy: agreed to sign/pay, a verbal yes, accepted
// pricing/terms, agreed to a trial or onboarding, a Stripe/prepay step. → advances
// stage to `negotiation` and floors intent Hot.
//
// SOFT = a move toward buying that is NOT yet a commitment: asked for a proposal,
// deck, case studies, or pricing; operational readiness questions. → advances stage
// to `proposal` and floors intent Warm.
//
// Heuristic on content for now (the preview showed the extractor tags both strong
// and soft under one category). A later pass can have the extractor emit `strength`
// directly; this classifier is the single place both the stage worker and the intent
// score read, so tightening it updates both at once. Conservative by design: only a
// clear commitment reads as strong; everything else defaults to soft.
const STRONG_PATTERNS = [
  /\bagreed?\b.{0,25}\b(sign|pay|prepay|proceed|start|onboard|trial|go ahead|move forward)\b/i,
  /\bwill\b.{0,15}\b(sign|pay|prepay|proceed|start)\b/i,
  /\bverbal(ly)?\b.{0,12}(commit|agree)/i,
  /\b(accept|agree|approv)\w*\b.{0,20}\b(pric|quote|proposal|fee|terms|offer)\b/i,
  /\bsign(ing|ed)?\b.{0,15}\b(agreement|proposal|contract|document|deal)\b/i,
  /\bstripe\b/i,
  // "will/agreed to prepay" is strong, but a bare mention of "prepayment" is not —
  // e.g. "wants to avoid the standard prepayment" is the opposite of a commitment.
  /\b(will|agreed? to|going to)\b.{0,12}\bprepay/i,
  /\bready to\b.{0,15}\b(buy|start|proceed|sign)\b/i,
];

export function isStrongBuyingSignal(content) {
  const t = String(content || '');
  return STRONG_PATTERNS.some(re => re.test(t));
}
