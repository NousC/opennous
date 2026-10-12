/**
 * What a locked surface says for itself.
 *
 * Deliberately NOT in config/plans.ts: that file is a mirror of apps/api/src/lib/plans.mjs
 * and every line in it has a server counterpart. Product copy does not, and putting it
 * there would make the two files drift on things the API has no opinion about.
 *
 * One entry per gated surface, shared by the sidebar tooltip and the upgrade page, so the
 * pitch you hover is the pitch you land on. Say what the surface DOES — no adjectives, no
 * "powerful", no "seamless". Short enough to read in a 240px tooltip.
 *
 * The PLAN NAME is not in here. It comes from lowestPlanWith(), so moving a feature down
 * the ladder never strands a sentence that names the old plan.
 */

import type { PlanFeatures } from '@/config/plans';

export type UpsellCopy = {
  /** What the surface is called in the nav. */
  name: string;
  /** One sentence: what it does. */
  pitch: string;
};

export const FEATURE_UPSELL: Partial<Record<keyof PlanFeatures, UpsellCopy>> = {
  accounts: {
    name: 'Accounts',
    pitch: 'The deal board — every company you work, grouped by stage, with the whole record one click deep. People stays; the board is on Growth.',
  },
  inAppAgent: {
    name: 'Threads',
    pitch: 'Ask about any account and the agent answers from your graph, in the app. No setup, no key of your own.',
  },
  tasks: {
    name: 'Tasks',
    pitch: "What's coming up and what you said you'd do, with every item handed to the agent to actually work.",
  },
  skills: {
    name: 'Skills',
    pitch: 'The procedures the agent runs, written down where you can read and change them.',
  },
  adoption: {
    name: 'Adoption',
    pitch: 'Who on the team is using the agents, on which accounts, and where they stopped.',
  },
  insights: {
    name: 'Insights',
    pitch: 'What every call taught you about your buyer, product and market, kept as one growing table.',
  },
};

/** Never render a blank card: a feature gated tomorrow still gets a sentence today. */
export function upsellCopy(feature: keyof PlanFeatures): UpsellCopy {
  return FEATURE_UPSELL[feature] ?? { name: feature, pitch: 'This is on a higher plan.' };
}
