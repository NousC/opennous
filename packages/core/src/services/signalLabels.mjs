// The account-signal kinds and their labels (moved out of automationRun.mjs in GET-884 so pure
// modules, the job card's brief among them, can read them without the run engine's imports).
export const SIGNAL_LABEL = {
  objection_raised: 'Objection raised', objection_resolved: 'Objection resolved',
  competitor_mentioned: 'Competitor mentioned', competitor_evaluating: 'Competitor being evaluated',
  stakeholder_identified: 'Key stakeholder identified', stakeholder_joined: 'New stakeholder', stakeholder_left: 'Stakeholder left',
  budget_discussed: 'Budget discussed', buying_signal: 'Buying signal', next_step: 'Next step agreed',
  expansion_signal: 'Expansion signal', expansion_declined: 'Expansion declined', churn_risk: 'Churn risk',
};
