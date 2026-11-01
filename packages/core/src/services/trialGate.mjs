// THE NO-CARD TRIAL'S END (GET-1087), in one place. When its fourteen days are up, syncing and
// reading stop and the data stays read-only. Here because the API, the worker and the CLI gate all
// have to give the same answer; plans.mjs re-exports these, and planIsLive, the worker's pulls and
// `nous backfill` all ask them. A row Stripe is billing, a comp, every Free row and a trial-like row
// with no end date are not this trial. An end date that cannot be read counts as ended.

/** A no-card trial row, running or ended. */
export function isNoCardTrial(subscription) {
  return !!subscription && subscription.status === 'trialing' && !subscription.stripe_subscription_id
    && !subscription.is_comp && !!subscription.trial_ends_at;
}

/** A no-card trial whose fourteen days are up. */
export function trialHasLapsed(subscription, now = Date.now()) {
  if (!isNoCardTrial(subscription)) return false;
  const end = Date.parse(subscription.trial_ends_at);
  return !Number.isFinite(end) || now >= end;
}
