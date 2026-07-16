// Shared TypeScript types — used by api, mcp, worker, sdk

// 'connected' = an accepted LinkedIn connection with no conversation yet. It sits
// above 'aware' but below 'interested', and is deliberately kept out of the People
// page (it would flood the list); it stays curable by the agent and via filters.
export type PipelineStage =
  | 'identified' | 'aware' | 'connected' | 'interested' | 'evaluating' | 'client'
  // terminal exits — off the active ladder, never decay, only an explicit
  // re-engagement revives them (see advancePipelineStage):
  | 'lost' | 'disqualified' | 'churned';

export type MemoryCategory = 'ICP' | 'Product' | 'Pricing' | 'Market' | 'Competitors' | 'Team' | 'Patterns' | 'General';

export type MemoryScope = 'contact' | 'company' | 'workspace';

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  company_id: string | null;
  title: string | null;
  linkedin_url: string | null;
  photo_url: string | null;
  channels: Record<string, unknown> | null;
  pipeline_stage: PipelineStage;
  icp_fit: string | null;
  icp_score: number | null;
  deal_health_score: number | null;
  last_activity_at: string | null;
  memory_summary: string | null;
}

export interface ContactProfile extends Contact {
  company_details: CompanyDetails | null;
  activities: Activity[];
  facts: MemoryFact[];
  signals_30d: Record<string, number>;
}

export interface CompanyDetails {
  name: string;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  location: string | null;
}

export interface Activity {
  id: string;
  type: string;
  description: string | null;
  body: string | null;
  source: string | null;
  occurred_at: string;
}

export interface MemoryFact {
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  written_at: string | null;
  graph_layer: 'private' | 'public';
}

export interface WorkspaceMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface ContactListItem {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  company_id: string | null;
  title: string | null;
  linkedin_url: string | null;
  channels: Record<string, unknown> | null;
  icp_fit: string | null;
  icp_score: number | null;
  deal_health_score: number | null;
  pipeline_stage: PipelineStage;
  last_activity_at: string | null;
}

export interface ListContactsParams {
  search?: string;
  pipeline_stage?: PipelineStage;
  company_id?: string;
  ids?: string;
  filter?: 'hot' | 'engaged';
  sort?: 'recent' | 'score' | 'deal_health_score' | 'connection_score' | 'urgency';
  limit?: number;
  offset?: number;
  linkedin_url?: string;
}

export interface CreateContactParams {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  job_title?: string;
  phone?: string;
  linkedin_url?: string;
  notes?: string;
}

export interface UpdateContactParams {
  first_name?: string;
  last_name?: string;
  company?: string;
  job_title?: string;
  phone?: string;
  linkedin_url?: string;
  notes?: string;
}

// ── Lead Lists (Adaptive Lead Scoring) ───────────────────────────────────────

export type LeadStatus = 'pending' | 'sent' | 'replied' | 'bounced';
export type ReplyOutcome = 'interested' | 'objection' | 'wrong_fit' | 'unsubscribe';

export interface LeadColumn {
  key: string;
  label: string;
}

export interface LeadList {
  id: string;
  workspace_id: string;
  name: string;
  source: string;            // 'linkedin' | 'instantly' | 'csv' | 'apollo' | …
  columns: LeadColumn[];     // user-defined columns beyond the fixed ones
  created_at: string;
  updated_at: string;
  lead_count?: number;       // populated by listLeadLists()
}

export interface Lead {
  id: string;
  lead_list_id: string;
  workspace_id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  linkedin_url: string | null;
  sent_at: string | null;
  send_variant: string | null;
  is_repeat_contact: boolean;
  features: Record<string, unknown>;
  fields: Record<string, unknown>;   // values for the list's user-defined columns
  scorecard_score: number | null;
  reply_outcome: ReplyOutcome | null;
  replied_at: string | null;
  status: LeadStatus;
  contact_id: string | null;
  created_at: string;
  updated_at: string;
  domain: string | null;
  email_status: string | null;
  last_channel: string | null;
  source: string | null;   // lead source, per-list (where this lead came from)
}

// ── The Scorecard (Adaptive Lead Scoring) ────────────────────────────────────

export interface ScorecardSignalRule {
  feature: string;
  // Categorical ops fire binary (full weight or nothing). 'scaled' is for
  // graded signal features (signal.<class> = a 0–10 strength): it contributes
  // weight × (score/10), with `value` as an optional floor (min score to count
  // at all), so a 9/10 signal outranks a 6/10 instead of counting the same.
  // 'contains_any' is a substring/keyword match: the feature (a text string or an
  // array of strings like the company's enriched `keywords`) contains ANY of
  // `value`'s terms (case-insensitive). It's how an exclusion fires on descriptive
  // enrichment text at score time — no website read — e.g. keywords ⊇ "cold calling".
  op: '==' | '!=' | '>=' | '<=' | '>' | '<' | 'in' | 'exists' | 'scaled' | 'contains_any';
  value?: unknown;
  // A disqualifier — "who we are NOT". When a disqualifying rule fires the
  // account is hard-capped into Not-ICP no matter how many positive signals it
  // also fires (a branding agency that happens to be 2–20 people is still out).
  // Authored from the ICP's exclusions, not learned. Carries a negative weight
  // too, but the cap — not the weight — is what makes it decisive.
  disqualify?: boolean;
}

export interface ScorecardSignal {
  id: string;
  workspace_id: string;
  key: string;
  label: string;
  weight: number;
  rule: ScorecardSignalRule;
  coverage: number;
  added_in: string | null;     // the learning run that added it; NULL = seed
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScorecardRun {
  id: string;
  workspace_id: string;
  target: number | null;
  steps: number;
  gap_before: number | null;
  gap_after: number | null;
  signal_count: number | null;
  note: string | null;
  created_at: string;
}
