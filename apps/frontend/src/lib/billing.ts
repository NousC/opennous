// What GET /api/billing/state returns, and the Stripe invoices Cloud lists beside it (GET-754:
// shared by the public Usage page and the Workspace layer's billing panel).

export type PlanInfo = {
  id: string;
  name: string;
  monthlyPriceUsd: number | null; // null = quoted (Custom)
  enrichmentsPerMonth?: number;
};

/** What this account's Custom plan is: the price agreed and what it bought. */
export type CustomPlan = {
  priceUsd: number | null;
  credits: number | null;
  basics: string[];
  custom: string[];
  customLabel?: string;
};

export type BillingState = {
  billing_disabled: boolean;
  self_hosted?: boolean;
  plan: string;
  planName?: string;
  customPlan?: CustomPlan | null;
  subscription?: {
    status: string;
    current_period_start?: string | null;
    current_period_end?: string | null;
    trial_ends_at?: string | null;
    cancel_at_period_end?: boolean;
    stripe_subscription_id?: string | null;
    is_comp?: boolean;
  } | null;
  /** THE meter. included: null = unlimited. */
  aiCredits?: {
    used: number;
    included: number | null;
    remaining: number | null;
    percentUsed: number;
    state: 'ok' | 'warn' | 'over' | 'restricted';
    /** The next bundle up, when there is one — what the overage notice offers. */
    nextTier?: { credits: number; priceUsd: number } | null;
    /** Not paying (GET-532, GET-539): never subscribed, canceled, or a card that failed. */
    needsPlan?: boolean;
    notLiveReason?: 'no_plan' | 'canceled' | 'payment_failed' | null;
    /** A failed card still inside its grace (GET-698): reading continues until graceUntil. */
    paymentFailed?: boolean;
    graceUntil?: string | null;
    periodStart: string | null;
    unlimited: boolean;
    /** The first backfill's credits, shown apart for 30 days (GET-515). */
    backfill?: { used: number; allowance: number | null; startedAt: string; showUntil: string } | null;
  } | null;
  allPlans?: PlanInfo[];
  /** Whether there is anything in Stripe to link to. Comped teams have neither. */
  stripe?: { customer: boolean; subscription: boolean } | null;
};

export type Invoice = {
  id: string;
  number: string | null;
  amount: number;
  currency: string;
  status: string;
  created: string;
  url: string | null;
  pdf: string | null;
};

/** Checkout, the Stripe portal and the invoice list: the Workspace layer's (lib/cloud.ts
 *  usage.useBilling). Self-host has no bill, so the public fallback does nothing. */
export interface BillingActions {
  invoices: Invoice[];
  /** What is in flight: "portal" or "subscribe:<plan>:<credits>". */
  action: string | null;
  subscribe: (plan: string, opts?: { interval?: "month" | "year"; promotion_code?: string; credits?: number }) => Promise<void>;
  openPortal: () => Promise<void>;
}
