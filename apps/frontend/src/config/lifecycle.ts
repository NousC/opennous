// The revenue LIFECYCLE — a separate axis from the sales ladder (config/pipeline.ts).
//
// The sales ladder (identified → closed_won) drives the forecast/win-rate math and stays
// untouched. This is the wider journey an account travels AFTER it's more than a deal:
//
//   SALES PIPELINE → HANDOFF → ACTIVATION → ACTIVE CUSTOMER → EXPANSION ─┐
//        ▲                                                                │
//        └──────────────── (upsell loops a new deal back to sales) ──────┘
//
// Each stage is OWNED by a department, so when an account crosses a boundary it moves into
// the receiving role's book and a handoff is logged (see lifecycle_events). The pre-sale
// stages are DERIVED from the sales ladder; the post-sale stages are SET (close-won hands
// off to CS; CS advances it; an upsell signal hands it back to sales).

export type LifecycleStage = "sales_pipeline" | "handoff" | "activation" | "active_customer" | "expansion";
export const LIFECYCLE_STAGES: LifecycleStage[] = ["sales_pipeline", "handoff", "activation", "active_customer", "expansion"];

export const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  sales_pipeline: "Sales Pipeline",
  handoff: "Handoff",
  activation: "Activation",
  active_customer: "Active Customer",
  expansion: "Expansion",
};

export const LIFECYCLE_COLOR: Record<LifecycleStage, string> = {
  sales_pipeline: "#2563eb",
  handoff: "#d97706",
  activation: "#7c3aed",
  active_customer: "#059669",
  expansion: "#FF5C00",
};

// Which department owns an account while it sits in each stage. Handoffs move ownership.
export type OwnerDept = "sales" | "customer_success";
export const LIFECYCLE_OWNER: Record<LifecycleStage, OwnerDept> = {
  sales_pipeline: "sales",
  handoff: "customer_success",
  activation: "customer_success",
  active_customer: "customer_success",
  expansion: "sales",
};
// job_role → the department it belongs to (for "accounts I own by my role").
export const ROLE_DEPT: Record<string, OwnerDept> = {
  sales: "sales", sdr: "sales", account_executive: "sales", founder: "sales", agency: "sales",
  customer_success: "customer_success",
};

// The effective lifecycle stage: a stored override wins; otherwise derive from the sales
// ladder. Terminal-but-lost accounts fall out of the lifecycle entirely (null).
// Won accounts cross into the lifecycle. Data uses both 'closed_won' and 'client' for won.
export const WON_STAGES = ["closed_won", "client"];
export function effectiveLifecycle(salesStage: string | null | undefined, stored: string | null | undefined): LifecycleStage | null {
  if (stored && (LIFECYCLE_STAGES as string[]).includes(stored)) return stored as LifecycleStage;
  const s = (salesStage ?? "").toLowerCase();
  if (["closed_lost", "disqualified", "churned"].includes(s)) return null;
  if (WON_STAGES.includes(s)) return "handoff";
  return "sales_pipeline";
}

// Sales Pipeline sub-stages — the sales ladder folded into the three groups a rep works.
export type SalesGroup = "lead" | "qualification" | "negotiation";
export const SALES_GROUPS: SalesGroup[] = ["lead", "qualification", "negotiation"];
export const SALES_GROUP_LABEL: Record<SalesGroup, string> = {
  lead: "Lead",
  qualification: "Qualification",
  negotiation: "Negotiation & Follow-ups",
};
// A progression toward the close: lead → qualification → negotiation.
export const SALES_GROUP_COLOR: Record<SalesGroup, string> = {
  lead: "#6366f1",
  qualification: "#d97706",
  negotiation: "#059669",
};
export function salesGroupOf(salesStage: string | null | undefined): SalesGroup | null {
  const s = (salesStage ?? "").toLowerCase();
  if (["identified", "connected", "interested"].includes(s)) return "lead";
  if (["meeting_booked", "discovery"].includes(s)) return "qualification";
  if (["demo", "proposal", "negotiation"].includes(s)) return "negotiation";
  return null;
}
