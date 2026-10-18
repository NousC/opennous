// The Customers page's view of GET /api/customer-success/accounts and GET /api/lifecycle/handoffs.
//
// The camelCase fields are what the route returns today (apps/api/src/lib/csReport.mjs `slim`).
// The snake_case ones are the Phase 2 contract additions; an older server or a preview fixture
// will not send them, so every reader falls back to the camelCase twin or renders a dash.

export type CsReason = {
  tier: number;
  kind: string;
  text: string;
  detail: string | null;
  evidence: "crm" | "said" | string;
  // Present when the reason came out of a conversation: the customer's own words, when, and how.
  quote?: string | null;
  at?: string | null;
  via?: string | null;
  product?: string | null;
  // A dated quote contradicting the CRM's own upgrade field. Shown, never smoothed over.
  conflict?: string | null;
  // "We promised" only: the task's due date and how late it is.
  due_at?: string | null;
  overdue_days?: number | null;
};

export type CsAccount = {
  companyId: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  lastActivityAt: string | null;
  daysQuiet: number | null;
  status: string | null;
  mrr: number | null;
  tier: string | null;
  csOwner: string | null;
  activeUsers: number | null;
  totalUsers: number | null;
  upgradeValue: number | null;
  upgradeStage: string | null;
  riskReasons: CsReason[];
  expansionReasons: CsReason[];
  // "We promised": what we owe them, its own list. Never a risk reason and never part of atRiskIds
  // (csHealth.mjs promiseOf). Up to five, most overdue first; promised_count is the full number.
  promisedReasons?: CsReason[];
  promised_count?: number;
  // Phase 2 contract additions.
  crm_health_score?: number | null;
  active_users_30d?: number | null;
  renewal_date?: string | null;
  // Months in the committed term that renews on renewal_date; 1 means month to month (no renewal).
  term_months?: number | null;
  cs_owner_name?: string | null;
  // Not in the contract yet. Read when a server sends them, so the column fills without a
  // frontend change: the AE on a handoff card, and the month-on-month change in active users.
  owner_name?: string | null;
  ownerName?: string | null;
  active_users_trend?: number | null;
};

export type CsPayload = {
  accounts: CsAccount[];
  expansionIds: string[];
  atRiskIds: string[];
  counts: { active: number; expansion: number; atRisk: number; churned: number; promised?: number; renewingSoon?: number };
  totals: { mrr: number; expansionValue: number; atRiskMrr: number; churnedMrr: number };
  healthReady: boolean;
  minedReady?: boolean;
  // scope=mine and we could not match the viewer to a CRM owner (apps/api/src/lib/ownerScope.mjs).
  scope_unmapped?: boolean;
};

export type Handoff = {
  id: string;
  company_id: string;
  company_name: string;
  company_domain: string | null;
  from_stage: string | null;
  to_stage: string;
  from_dept: string | null;
  to_dept: string | null;
  reason: string | null;
  note: string | null;
  created_at: string;
  acknowledged_at: string | null;
  // A change of CS owner in the CRM (reason "cs_owner_change"): who had it and who has it now.
  from_owner?: string | null;
  to_owner?: string | null;
};

export type Scope = "mine" | "team";
export type CsView = "attention" | "handoffs" | "renewals" | "expansion" | "all";

// ── reading a row, contract field first ─────────────────────────────────────────────────────

export const csOwnerOf = (a: CsAccount): string | null => a.cs_owner_name ?? a.csOwner ?? null;
export const activeUsersOf = (a: CsAccount): number | null => a.active_users_30d ?? a.activeUsers ?? null;
export const aeOf = (a: CsAccount | undefined): string | null => a?.owner_name ?? a?.ownerName ?? null;

const DAY = 86_400_000;

/** Days from today to a "YYYY-MM-DD" (or ISO) date; negative once it has passed. */
export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / DAY);
}

export const RENEWAL_WINDOW_DAYS = 60;
/** Month to month: no renewal date by design, the customer can leave any month. */
export const isMonthly = (a: CsAccount): boolean => !a.renewal_date && a.term_months === 1;

/** What we owe them, contract field first; an older server sent these as "owed" risk reasons. */
export const promisesOf = (a: CsAccount | undefined): CsReason[] =>
  a?.promisedReasons ?? (a?.riskReasons ?? []).filter((r) => r.kind === "owed" || r.kind === "promised");

/** A handoff into Customer Success: a deal closing won, or the CRM naming a new CS owner. */
export const isCsHandoff = (h: Handoff): boolean =>
  !h.acknowledged_at && h.to_dept === "customer_success" && (h.from_dept !== "customer_success" || h.reason === "cs_owner_change");

export const renewsSoon = (a: CsAccount): boolean => {
  const d = daysUntil(a.renewal_date);
  return d != null && d >= 0 && d <= RENEWAL_WINDOW_DAYS;
};

// GET /handoffs writes an event for every won account that never had one, so the first read on a
// workspace with history produces hundreds at once. Those are a backlog, not this week's work, so
// the tab leads with the recent ones and folds the rest behind a count instead of burying a real
// handoff under them.
export const RECENT_HANDOFF_DAYS = 30;

export function splitHandoffs(list: Handoff[]): { recent: Handoff[]; older: Handoff[] } {
  const cutoff = Date.now() - RECENT_HANDOFF_DAYS * DAY;
  const recent: Handoff[] = [];
  const older: Handoff[] = [];
  for (const h of list) (Date.parse(h.created_at) >= cutoff ? recent : older).push(h);
  return { recent, older };
}

export const fmtMoney =(n: number | null | undefined): string => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 10_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v).toLocaleString()}`;
};

/** "Nov 30" this year, "Mar 2027" beyond it. A renewal date is a month decision, not a timestamp. */
export function fmtDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() === new Date().getFullYear()
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
