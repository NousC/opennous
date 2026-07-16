// CRM hygiene — the reconcile DECISION function (Task 2). Pure:
// (claim, V_crm, provenance) → a proposed change or null. Never writes to a CRM.
// Plus rejection memory so a dismissed proposal isn't regenerated and nag.
//
// Conservative by design (the honest conflict rule): a differing non-empty CRM
// value is a `conflict`, never a silent overwrite, UNLESS our side is
// independently strong (human-asserted, or corroborated-and-fresh). We do not
// infer "human edited after us" from timestamps — CRM edit times are
// record-level on Pipedrive/Attio (see crm-sync.md §4.2).
// See docs/crm-hygiene-phase-1b-spec.md, Task 2.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReconcileClaim } from '../db/claims.js';
import type { ProvenanceVerdict, SupportingEvidence } from './crmProvenance.js';

export type ReconcileKind = 'field_fill' | 'field_update' | 'conflict';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

// Free-text fields v1 reconciles — those we can both hold a claim for and read
// as a STANDARD field from at least one provider. Enum (seniority, industry) and
// relationship/custom fields are deferred (crm-sync.md §4.5). A provider only
// proposes for the subset its fetch returns (HubSpot: all three; Pipedrive:
// company/phone; Attio: job_title/phone).
export const RECONCILE_PROPERTIES = ['job_title', 'company', 'phone'] as const;

/** Normalize a field value for comparison (trim + casefold). Free-text only —
 *  enum/picklist normalization is deferred (crm-sync.md §4.5). */
export function normalizeFieldValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim().toLowerCase();
  return JSON.stringify(v).trim().toLowerCase();
}

export interface ReconcileInput {
  field: string;
  claim: ReconcileClaim;
  crmValue: unknown;            // V_crm, as the CRM currently holds it
  provenance: ProvenanceVerdict;
  confidenceThreshold?: number; // τ, default 0.6
}

export interface ReconcileDecision {
  kind: ReconcileKind;
  field: string;
  currentValue: unknown;          // V_crm as-is
  proposedValue: unknown;         // our claim value
  confidence: number;             // 0..1 (claim confidence)
  reason: string;
  evidence: SupportingEvidence[]; // the non-CRM observations backing our value
}

/**
 * Decide whether the CRM should change for one (claim, field). Pure; returns
 * null when nothing should be proposed.
 */
export function decideReconcile(input: ReconcileInput): ReconcileDecision | null {
  const { claim, crmValue, provenance, field } = input;
  const tau = input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  // ── Eligibility gate ──
  if (claim.epistemic_class !== 'observed' && claim.epistemic_class !== 'asserted') return null; // predicted/inferred never reconciled
  if (claim.confidence < tau) return null;
  if (claim.freshness !== 'fresh' && claim.freshness !== 'aging') return null;                    // suspect/expired → skip
  if (!provenance.passes) return null;                                                            // loop-prevention gate (Task 1)
  if (normalizeFieldValue(claim.value) === '') return null;                                       // nothing to write

  const nClaim = normalizeFieldValue(claim.value);
  const nCrm = normalizeFieldValue(crmValue);

  const base = {
    field,
    currentValue: nCrm === '' ? null : crmValue,   // empty CRM field → null, not ""
    proposedValue: claim.value,
    confidence: claim.confidence,
    evidence: provenance.independentObservations,
  };

  if (nCrm === '') {
    return { ...base, kind: 'field_fill', reason: `Empty in CRM; fill from ${provenance.bestSource ?? 'independent evidence'}.` };
  }
  if (nCrm === nClaim) return null; // already matches — no-op

  // Values differ. Only overwrite when our side is independently strong.
  const strong = claim.epistemic_class === 'asserted'
    || (claim.observation_count >= 2 && claim.freshness === 'fresh');

  if (strong) {
    const reason = claim.epistemic_class === 'asserted'
      ? 'CRM differs; our value was directly stated (asserted).'
      : `CRM differs; our value is corroborated (${claim.observation_count} observations) and fresh.`;
    return { ...base, kind: 'field_update', reason };
  }

  return {
    ...base, kind: 'conflict',
    reason: "CRM holds a different value; our evidence isn't strong enough to overwrite — flagged for review.",
  };
}

/**
 * Rejection memory. True if a proposal with this exact proposed value for
 * (provider, entity, field) was dismissed within the window — so we don't
 * regenerate it and nag. A changed proposed value earns a fresh look.
 */
export async function isSuppressedByRejection(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  entityId: string,
  field: string,
  proposedValue: unknown,
  windowDays = 90,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data } = await supabase
    .from('crm_hygiene_proposals')
    .select('proposed_value')
    .eq('workspace_id', workspaceId)
    .eq('provider', provider)
    .eq('entity_id', entityId)
    .eq('field', field)
    .eq('status', 'dismissed')
    .gte('created_at', cutoff);
  const target = normalizeFieldValue(proposedValue);
  return (data ?? []).some((r: { proposed_value: unknown }) => normalizeFieldValue(r.proposed_value) === target);
}
