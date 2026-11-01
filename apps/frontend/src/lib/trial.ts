// What the trial banner says (GET-1087). Pure, so tests/trial.test.ts pins it.

export type TrialBillingState = {
  aiCredits?: { trial?: { daysLeft: number; ended: boolean } | null } | null;
} | null | undefined;

/** The banner, or null when this workspace is not on a trial. */
export function trialBanner(state: TrialBillingState): { tone: "risk" | "neutral" | "warning"; text: string } | null {
  const t = state?.aiCredits?.trial;
  if (!t) return null;
  if (t.ended) return { tone: "risk", text: "Trial ended. Everything has stopped. Subscribe to continue: your data is kept." };
  const days = `${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`;
  return { tone: t.daysLeft <= 3 ? "warning" : "neutral", text: `Trial: ${days} left.` };
}

/** The trial is over: the app is a subscribe screen until they pay. */
export const trialEnded = (state: TrialBillingState) => !!state?.aiCredits?.trial?.ended;

/** Billing, settings and admin stay reachable behind the wall. Everything else is the wall. */
export const trialWallApplies = (path: string) => !/^\/(billing|settings|company|admin)(\/|$)/.test(path);
