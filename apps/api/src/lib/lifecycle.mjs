// The revenue lifecycle — server mirror of apps/frontend/src/config/lifecycle.ts.
// A separate axis from the sales ladder (packages/core pipeline). See the frontend file
// for the full model. This lib carries only what the API needs: the stage list, the
// department that owns each stage, the forward order, and the handoff role mapping.

export const LIFECYCLE_STAGES = ['sales_pipeline', 'handoff', 'activation', 'active_customer', 'expansion'];

// Which department owns an account while it sits in each stage.
export const LIFECYCLE_OWNER = {
  sales_pipeline: 'sales',
  handoff: 'customer_success',
  activation: 'customer_success',
  active_customer: 'customer_success',
  expansion: 'sales',
};

// The default forward move (the "advance" button). Expansion loops a new deal to sales.
export const LIFECYCLE_NEXT = {
  sales_pipeline: 'handoff',
  handoff: 'activation',
  activation: 'active_customer',
  active_customer: 'expansion',
  expansion: 'sales_pipeline',
};

export const ownerDeptOf = (stage) => LIFECYCLE_OWNER[stage] ?? 'sales';
export const isLifecycleStage = (s) => LIFECYCLE_STAGES.includes(s);

// job_role → department, so a handoff can be routed to the receiving person's book.
export const ROLE_DEPT = {
  sales: 'sales', sdr: 'sales', account_executive: 'sales', founder: 'sales', agency: 'sales',
  customer_success: 'customer_success',
};
