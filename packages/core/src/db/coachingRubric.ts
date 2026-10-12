import type { SupabaseClient } from '@supabase/supabase-js';

// Coaching v2 (GET-82): the rubric — "what good looks like" for this team. The server-side scorer
// (GET-83) grades each call against the rubric for the rep's role; the Coaching page and the
// after-call skill read it. Role-aware, editable, with shipped defaults so scoring works out of
// the box. Weights per rubric sum to 100.

export interface RubricDimension {
  key: string;     // stable id, e.g. 'discovery_depth'
  label: string;   // display, e.g. 'Discovery depth'
  weight: number;  // 0–100; the dimensions of a rubric sum to 100
  good: string;    // what a strong call looks like on this dimension (the scorer's guide)
}

export interface CoachingRubric {
  role: string;         // GTM role this rubric applies to, or 'default'
  methodology: string;  // 'meddicc' | 'bant' | 'custom'
  dimensions: RubricDimension[];
  version: number;
}

// MEDDICC — the default methodology 'methodology adherence' grades against. Selectable per team.
export const MEDDICC = [
  'metrics', 'economic_buyer', 'decision_criteria', 'decision_process',
  'identify_pain', 'champion', 'competition',
] as const;

export const BANT = ['budget', 'authority', 'need', 'timing'] as const;

// The shipped AE / sales-call default, as ruled 2026-09-14 (GET-236): the five stages of a sales
// call plus talk / listen. Discovery and the close carry the most weight.
const AE_DIMENSIONS: RubricDimension[] = [
  { key: 'discovery',          label: 'Discovery',          weight: 25, good: 'Uncovered the real pain, why now, its business impact and who decides, and anchored it in numbers rather than surface interest.' },
  { key: 'rapport',            label: 'Rapport',            weight: 10, good: 'Built genuine trust: listened, used names correctly, kept it peer-to-peer rather than vendor-to-buyer.' },
  { key: 'objection_handling', label: 'Objection handling', weight: 20, good: 'Objection named, answered with proof, and confirmed it landed, not dodged or left hanging.' },
  { key: 'demo',               label: 'Demo',               weight: 15, good: 'Showed the product against this buyer’s own pain and stack rather than a feature tour, and checked it landed.' },
  { key: 'close',              label: 'Close & next steps', weight: 20, good: 'Asked for the commitment and left with a specific, dated next step with an owner, not "I’ll send info".' },
  { key: 'talk_listen',        label: 'Talk / listen',      weight: 10, good: 'Let the buyer talk: the rep speaking roughly 45% or less, asking and listening rather than monologuing.' },
];

// The shipped SDR default — swaps discovery/next-step for opener + qualification + meeting-secured.
const SDR_DIMENSIONS: RubricDimension[] = [
  { key: 'opener_quality',     label: 'Opener quality',      weight: 20, good: 'A relevant, personalized opener that earned the next 30 seconds — not a generic pitch.' },
  { key: 'qualification',      label: 'Qualification',       weight: 25, good: 'Established fit and intent (right role, real pain, plausible timing) before pushing for a meeting.' },
  { key: 'objection_handling', label: 'Objection handling',  weight: 20, good: 'Handled the brush-off with a crisp, honest reframe and kept the conversation alive.' },
  { key: 'meeting_secured',    label: 'Meeting secured',     weight: 20, good: 'Booked a specific, dated meeting with the right person — not a vague "send me info".' },
  { key: 'talk_listen_ratio',  label: 'Talk / listen ratio', weight: 15, good: 'Asked and listened rather than monologuing the pitch.' },
];

// ── What KIND of call this was (GET-287) ────────────────────────────────────
//
// One sales rubric graded every call, so a customer-success check-in was marked down for not
// closing and a demo for not doing discovery. Measured on one customer's year of Fellow meetings:
// hundreds of business reviews, training calls and support calls against a few dozen demos and
// discoveries — the majority of calls were being graded on a job nobody on them was doing.
//
// So the rubric is chosen by the call's TYPE first, and the rep's role only picks between
// families. Three families, not fifteen: selling, prospecting, and success.

/** A demo is judged on whether it hit THIS buyer's world, not on whether it discovered it. */
const DEMO_DIMENSIONS: RubricDimension[] = [
  { key: 'tailoring',          label: 'Tailored to them',   weight: 30, good: 'Showed the product against this buyer’s own pain, stack and words — not a feature tour.' },
  { key: 'engagement',         label: 'Engagement',         weight: 20, good: 'Stopped to check it landed, invited reactions, and let the buyer drive where it went.' },
  { key: 'objection_handling', label: 'Objection handling', weight: 15, good: 'Took the doubt seriously, answered with proof, and confirmed it landed.' },
  { key: 'proof',              label: 'Proof',              weight: 15, good: 'Backed claims with something real: numbers, a customer like them, a live artefact.' },
  { key: 'close',              label: 'Close & next steps', weight: 20, good: 'Left with a specific, dated next step and the right people named for it.' },
];

/** A first conversation. Everything rides on what was learned, not on what was shown. */
const DISCOVERY_DIMENSIONS: RubricDimension[] = [
  { key: 'discovery',          label: 'Discovery',          weight: 35, good: 'Uncovered the real pain, why now, its business impact and who decides, anchored in numbers.' },
  { key: 'rapport',            label: 'Rapport',            weight: 15, good: 'Built genuine trust: listened, used names correctly, kept it peer-to-peer.' },
  { key: 'qualification',      label: 'Qualification',      weight: 20, good: 'Established fit honestly — and was willing to find there was none.' },
  { key: 'close',              label: 'Close & next steps', weight: 20, good: 'Left with a specific, dated next step with an owner, not “I’ll send info”.' },
  { key: 'talk_listen',        label: 'Talk / listen',      weight: 10, good: 'Let the buyer talk: the rep speaking roughly 45% or less.' },
];

/** Proposal, negotiation, the close. Discovery is behind them; this is about getting a decision. */
const CLOSING_DIMENSIONS: RubricDimension[] = [
  { key: 'decision_process',   label: 'Decision process',   weight: 25, good: 'Knows who signs, what happens next, and by when — and said it out loud on the call.' },
  { key: 'value_case',         label: 'Value case',         weight: 20, good: 'Tied the price to the buyer’s own numbers rather than defending a list price.' },
  { key: 'objection_handling', label: 'Objection handling', weight: 25, good: 'The real blocker named and answered, not deferred to “let me check internally”.' },
  { key: 'close',              label: 'Close',              weight: 20, good: 'Asked for the decision and secured a dated commitment.' },
  { key: 'talk_listen',        label: 'Talk / listen',      weight: 10, good: 'Let the buyer talk through their hesitation rather than talking over it.' },
];

/** Onboarding / kickoff: the handover. Selling is done; this decides whether they ever get value. */
const ONBOARDING_DIMENSIONS: RubricDimension[] = [
  { key: 'expectations',       label: 'Expectations set',   weight: 25, good: 'Said plainly what happens, by when, and what the customer has to do — no vague “we’ll get you set up”.' },
  { key: 'setup_completeness', label: 'Setup completeness',  weight: 25, good: 'Walked the actual configuration and left nothing half-done or unassigned.' },
  { key: 'stakeholders',       label: 'The right people',   weight: 20, good: 'The people who will use it were on the call, and the owner on their side is named.' },
  { key: 'time_to_value',      label: 'Time to value',      weight: 20, good: 'Named the first outcome they will see and when — a date, not an aspiration.' },
  { key: 'next_step',          label: 'Next step',          weight: 10, good: 'A specific, dated next session or checkpoint with an owner.' },
];

/** Training / enablement: did the people on the call leave able to do the thing. */
const TRAINING_DIMENSIONS: RubricDimension[] = [
  { key: 'clarity',            label: 'Clarity',            weight: 30, good: 'Explained in the customer’s language, at their level, checking understanding rather than narrating features.' },
  { key: 'hands_on',           label: 'Hands on',           weight: 25, good: 'The customer did it themselves on the call instead of watching it being done.' },
  { key: 'adoption_barriers',  label: 'Adoption barriers',  weight: 25, good: 'Asked what is stopping them using it and dealt with the answer.' },
  { key: 'next_step',          label: 'Next step',          weight: 20, good: 'Left with who does what by when, and how they get help.' },
];

/** A business review / check-in. Nobody is closing anything; the question is whether it is working. */
const BUSINESS_REVIEW_DIMENSIONS: RubricDimension[] = [
  { key: 'value_delivered',    label: 'Value delivered',    weight: 30, good: 'Showed what they got against what they bought, in their numbers — not a usage chart.' },
  { key: 'adoption',           label: 'Adoption',           weight: 20, good: 'Established who actually uses it, how, and where it stalled.' },
  { key: 'risk',               label: 'Risk surfaced',      weight: 20, good: 'Asked what could make them leave and heard the honest answer, including silence about a sponsor who has left.' },
  { key: 'expansion',          label: 'Expansion signal',   weight: 15, good: 'Noticed a real opening — a new team, a new need — without pitching over the review.' },
  { key: 'next_step',          label: 'Next step',          weight: 15, good: 'A dated next checkpoint with an owner on both sides.' },
];

/** Call type → the rubric that judges it. Types absent here are not scored. */
const BY_CALL_TYPE: Record<string, RubricDimension[]> = {
  discovery:       DISCOVERY_DIMENSIONS,
  demo:            DEMO_DIMENSIONS,
  proposal:        CLOSING_DIMENSIONS,
  onboarding:      ONBOARDING_DIMENSIONS,
  training:        TRAINING_DIMENSIONS,
  business_review: BUSINESS_REVIEW_DIMENSIONS,
  // 'sales' is the legacy catch-all every scorecard carried before types existed: a sales
  // conversation we could not place more precisely. It keeps the AE rubric.
  sales:           AE_DIMENSIONS,
};

/** The call types we grade. Support, internal and other are mined for intel but never scored. */
export const SCORED_CALL_TYPES = Object.keys(BY_CALL_TYPE);

/**
 * The rubric for a call: its TYPE decides, the rep's role only breaks ties.
 *
 * An SDR's discovery call is a prospecting call — theirs is the one role whose whole job changes
 * the shape of the conversation, so it keeps its own rubric. Everyone else is judged on what the
 * call was for.
 */
export function rubricDimensionsFor(callType?: string | null, role = 'default'): RubricDimension[] {
  const r = String(role || 'default').toLowerCase();
  const t = String(callType || '').toLowerCase();
  if ((r === 'sdr' || r === 'bdr') && (t === 'discovery' || t === 'sales' || !t)) return SDR_DIMENSIONS;
  return BY_CALL_TYPE[t] ?? DEFAULTS[r] ?? DEFAULTS.default;
}

// Role → default rubric. account_executive is also the 'default' fallback.
const DEFAULTS: Record<string, RubricDimension[]> = {
  default:           AE_DIMENSIONS,
  account_executive: AE_DIMENSIONS,
  sales:             AE_DIMENSIONS,
  sdr:               SDR_DIMENSIONS,
  bdr:               SDR_DIMENSIONS,
};

/** The shipped default rubric for a role (falls back to the AE rubric). */
export function defaultRubric(role = 'default', callType?: string | null): CoachingRubric {
  return { role, methodology: 'meddicc', dimensions: rubricDimensionsFor(callType, role), version: 1 };
}

/** Weights must sum to 100 (±1 for rounding) and every dimension needs a key + positive weight. */
export function validateRubric(dims: RubricDimension[]): string | null {
  if (!Array.isArray(dims) || dims.length === 0) return 'rubric needs at least one dimension';
  for (const d of dims) {
    if (!d.key || typeof d.key !== 'string') return 'every dimension needs a key';
    if (typeof d.weight !== 'number' || d.weight < 0) return `dimension ${d.key} needs a non-negative weight`;
  }
  const sum = dims.reduce((a, d) => a + d.weight, 0);
  if (Math.abs(sum - 100) > 1) return `weights must sum to 100 (got ${sum})`;
  return null;
}

/**
 * The rubric to score a call by: the workspace's stored rubric for the role, else the rubric for
 * this KIND of call, else the role default. The scorer, the Coaching page and the after-call skill
 * all read through this.
 *
 * A team that has written its own rubric keeps it — their words beat our defaults, whatever the
 * call type. Everyone else is judged on what the call was actually for (GET-287).
 */
export async function getCoachingRubric(
  supabase: SupabaseClient,
  workspaceId: string,
  role = 'default',
  callType?: string | null,
): Promise<CoachingRubric> {
  // Try the exact role, then 'default', before falling back to code defaults.
  const { data } = await supabase
    .from('coaching_rubrics')
    .select('role, methodology, dimensions, version')
    .eq('workspace_id', workspaceId)
    .in('role', [role, 'default']);

  const forRole = (data ?? []).find((r) => r.role === role)
              ?? (data ?? []).find((r) => r.role === 'default');
  if (forRole) {
    return {
      role: forRole.role,
      methodology: forRole.methodology || 'meddicc',
      dimensions: (forRole.dimensions as RubricDimension[]) || defaultRubric(role, callType).dimensions,
      version: forRole.version ?? 1,
    };
  }
  return defaultRubric(role, callType);
}

/** Create or replace the rubric for a (workspace, role). Bumps version on each save. */
export async function upsertCoachingRubric(
  supabase: SupabaseClient,
  workspaceId: string,
  role: string,
  input: { methodology?: string; dimensions: RubricDimension[]; updatedBy?: string | null },
): Promise<CoachingRubric> {
  const err = validateRubric(input.dimensions);
  if (err) throw new Error(err);

  const { data: existing } = await supabase
    .from('coaching_rubrics')
    .select('version')
    .eq('workspace_id', workspaceId).eq('role', role).maybeSingle();
  const version = (existing?.version ?? 0) + 1;

  const row = {
    workspace_id: workspaceId,
    role,
    methodology: input.methodology || 'meddicc',
    dimensions: input.dimensions,
    version,
    updated_by: input.updatedBy ?? null,
    updated_at: new Date().toISOString(),
  };
  await supabase.from('coaching_rubrics').upsert(row, { onConflict: 'workspace_id,role' });
  return { role, methodology: row.methodology, dimensions: input.dimensions, version };
}
