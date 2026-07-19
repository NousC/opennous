/**
 * The guided setup tour.
 *
 * Not a wizard on its own screen. It walks the user through the REAL pages — Integrations,
 * Accounts, the ICP model — spotlighting the actual button they need to click, and it only
 * moves on once the step is genuinely done (a source connected, accounts imported, closed
 * deals fed to the model). The agent may have already stood up the ICP; this is the part a
 * human still has to do, so we lead them through it instead of dropping them into an empty
 * app.
 *
 * The three middle steps are gated on server truth (see useTourProgress → /api/onboarding
 * /status). The bookends (welcome, billing) are just cards.
 */

export type TourCheckpoint = 'integrationConnected' | 'accountsImported' | 'icpTrained';

export interface TourStep {
  id: string;
  /** Send the user here when the step activates. Includes any query the anchor needs. */
  route?: string;
  /** data-tour value of the element to spotlight. Missing element → the card centers. */
  anchor?: string;
  title: string;
  body: string;
  /** The server signal that marks this step done. Absent for the bookend cards. */
  checkpoint?: TourCheckpoint;
  /** Centered card (welcome/billing) vs a spotlight anchored to a button. */
  placement: 'center' | 'anchor';
  /** Label for the manual advance button on the bookend cards. */
  cta?: string;
  /** Optional second button on a centered card — takes them somewhere, then ends the tour.
   *  Used for the "add a verifier" nudge on the finish card. */
  secondaryCta?: string;
  secondaryRoute?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    placement: 'center',
    title: 'Welcome to Nous',
    body: "Three quick steps to get your workspace live.",
    cta: 'Show me',
  },
  {
    id: 'integration',
    placement: 'anchor',
    route: '/integrations',
    anchor: 'add-integration',
    checkpoint: 'integrationConnected',
    title: 'Connect your data',
    body: 'Click the plus to connect a source. Start with Gmail. Your CRM, notetaker and calendar make it richer.',
  },
  {
    id: 'accounts',
    placement: 'anchor',
    route: '/accounts?tab=people',
    anchor: 'import-accounts',
    checkpoint: 'accountsImported',
    title: 'Import your accounts',
    body: 'Click Import to bring in the people you work with. Drop a CSV, or pull them from a connected CRM.',
  },
  {
    id: 'icp',
    placement: 'anchor',
    route: '/icp',
    anchor: 'add-deals',
    checkpoint: 'icpTrained',
    title: 'Build your ICP model',
    body: 'Click Add deals and paste your closed-won and closed-lost domains. Nous learns what your best customers share.',
  },
  {
    id: 'billing',
    placement: 'center',
    // Title is personalized to "Congrats, <name>" in GuidedTour when we know the name.
    title: 'Congrats',
    body: "You've completed onboarding, and your agents now hold the complete picture of every buyer in your pipeline. Pricing only covers active accounts, so we never store cold leads with no activity.",
    cta: 'Next',
  },
  {
    id: 'verify',
    placement: 'center',
    title: "You're all set",
    body: 'Optional: add NeverBounce or MillionVerifier and we enrich and verify contacts in your accounts automatically.',
    cta: 'Done',
    secondaryCta: 'Add a verifier',
    secondaryRoute: '/integrations',
  },
];

// ── Persistence ──────────────────────────────────────────────────────────────
// Scoped to the workspace, so a second account in the same browser gets its own tour and a
// finished one never re-runs.

export type TourStatus = 'unstarted' | 'active' | 'dismissed' | 'done';

export interface TourState {
  status: TourStatus;
  step: number;
}

const KEY = (wsId: string) => `nous_tour:${wsId}`;

export function loadTourState(wsId: string): TourState {
  try {
    const raw = localStorage.getItem(KEY(wsId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<TourState>;
      if (p && typeof p.status === 'string' && typeof p.step === 'number') {
        return { status: p.status as TourStatus, step: p.step };
      }
    }
  } catch { /* ignore */ }
  return { status: 'unstarted', step: 0 };
}

export function saveTourState(wsId: string, state: TourState) {
  try { localStorage.setItem(KEY(wsId), JSON.stringify(state)); } catch { /* ignore */ }
}
