// The account-signal kinds and their labels (moved out of automationRun.mjs in GET-884 so pure
// modules, the job card's brief among them, can read them without the run engine's imports).
export const SIGNAL_LABEL = {
  objection_raised: 'Objection raised', objection_resolved: 'Objection resolved',
  competitor_mentioned: 'Competitor mentioned', competitor_evaluating: 'Competitor being evaluated',
  stakeholder_identified: 'Key stakeholder identified', stakeholder_joined: 'New stakeholder', stakeholder_left: 'Stakeholder left',
  budget_discussed: 'Budget discussed', buying_signal: 'Buying signal', next_step: 'Next step agreed',
  expansion_signal: 'Expansion signal', expansion_declined: 'Expansion declined', churn_risk: 'Churn risk',
  // Read by the worker's next-step pass, not the claims trigger (GET-954, nextStepSignals.mjs).
  next_step_missed: 'Next step missed', next_step_slipped: 'Next step slipped',
  // Read by the PostHog usage pull (GET-751, usageSignals.mjs).
  usage_dropped: 'Usage dropped', account_inactive: 'Account inactive', feature_adopted: 'Feature adopted', seat_dropped: 'Seat dropped',
  product_qualified: 'Product-qualified', seats_growing: 'Seats growing', account_activated: 'Account activated',
};

/** The kinds a periodic pass writes rather than the claims trigger (GET-954). */
export const DETECTED_SIGNAL_KINDS = Object.freeze(['next_step_missed', 'next_step_slipped', 'usage_dropped', 'account_inactive', 'feature_adopted', 'seat_dropped', 'product_qualified', 'seats_growing', 'account_activated']);

/**
 * Kinds that are tasks, not signals (GET-954): a next step agreed is what someone already said they
 * would do. It stays an account_signals row (missed and slipped are read from the steps), but it is
 * not a signal a person sees (not the Accounts table's latest signal, not the account's signal list,
 * not a picker, not an "any signal" automation) and, since GET-967, not an event or a webhook.
 */
export const TASK_SIGNAL_KINDS = Object.freeze(['next_step']);

/** Is this kind shown to a person as a signal? */
export const shownAsSignal = (kind) => !TASK_SIGNAL_KINDS.includes(kind);
