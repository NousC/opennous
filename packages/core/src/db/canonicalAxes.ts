import type { SupabaseClient } from '@supabase/supabase-js';

// Canonical axes — the normalization layer for auto-reconcile (P1).
//
// A canonical axis is an enum property (e.g. `lifecycle`) that MANY sources describe in
// their own vocabulary. `source_field_map` translates each source's raw field/event onto
// the axis; `source_authority` says how much to trust each source on it. Both tables carry
// GLOBAL defaults (workspace_id null, seeded in the migration) that a workspace row can
// override.
//
// Registering an axis here is what routes its claim through the authority-aware derivation
// (see deriveAuthoritativeClaim / recomputeClaim) instead of the plain recency engine.

// Properties reconciled by source authority instead of recency. A newer low-authority
// source must not silently overwrite an older authoritative one:
//   - lifecycle           Stripe (paid) beats a stale Salesforce churn.
//   - reachability_status a real verifier (neverbounce/millionverifier) beats an
//                         enrichment provider's guess, even a newer guess.
//   - job_title           LinkedIn beats a stale CRM title — but freshness decay lets a
//                         FRESH CRM title overtake a stale LinkedIn one (the right tradeoff).
//   - employee_count      a firmographic provider beats a stale/blank CRM headcount.
// Weights live in source_authority (global defaults seeded per axis; workspace-overridable).
export const AUTHORITY_AXES = new Set<string>([
  'lifecycle', 'reachability_status', 'job_title', 'employee_count',
  // Firmographic facts two systems genuinely disagree about. Measured on production before
  // adding: `company` and `seniority` both differ across sources on real entities.
  'company', 'seniority',
]);

export function isAuthorityAxis(property: string): boolean {
  return AUTHORITY_AXES.has(property);
}

// Of the authority axes, which also raise a reviewable row on the Conflicts surface when
// sources disagree. Enum / low-cardinality axes belong here; free-text axes like job_title
// reconcile silently, because near-duplicate strings ("VP Sales" vs "VP of Sales") would
// flood the panel with trivial, auto-resolved conflicts. Authority still picks the winner
// for job_title — it just isn't surfaced for human review.
export const CONFLICT_AXES = new Set<string>([
  'lifecycle', 'reachability_status', 'employee_count',
  // ── Added 2026-09-13, after measuring ──
  //
  // The surface had produced ZERO rows in its entire life. Not a wiring bug: the three axes
  // above are enum-shaped and safe, and almost nothing in production ever disagrees on them
  // — a few hundred claims between them, a handful with more than one observation. The machinery worked
  // perfectly on a set of questions nobody was asking.
  //
  // What sources DO disagree about, counted: company (the most), then job_title, then
  // seniority. Those are the "Salesforce says Director, HubSpot says VP" cases — the
  // disagreements an operator actually wants to see.
  //
  // ⚠️ `pipeline_stage` is deliberately NOT here, despite hundreds of entities where two sources
  // differ. That disagreement is mostly OUR derivation against the CRM's field, which is the
  // system working as designed rather than a data fault — surfacing it would put hundreds of rows of
  // expected behaviour on a review queue and teach everyone to ignore the queue. It deserves
  // its own treatment, not this one.
  'company', 'job_title', 'seniority',
]);

/**
 * Do two values disagree in a way worth a human's time?
 *
 * The reason free-text axes were excluded: "VP Sales" and "VP of Sales" are the same job, and
 * a panel that raises that has taught its reader to close it. Compared on letters and digits
 * only, so case, punctuation, spacing and filler words cannot manufacture a conflict.
 */
const FILLER = /\b(of|the|and|at|inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|sa)\b/g;
export function valuesGenuinelyDiffer(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    String(v ?? '').toLowerCase().replace(FILLER, ' ').replace(/[^a-z0-9]+/g, '').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;          // an absence is not a disagreement
  return x !== y;
}

export function isConflictAxis(property: string): boolean {
  return CONFLICT_AXES.has(property);
}

export type FieldMapKind = 'state_field' | 'event';
export type FieldMatchType = 'eq' | 'prefix' | 'regex';

export interface SourceFieldMap {
  source: string;
  match_kind: FieldMapKind;
  source_key: string;
  match: string | null;
  match_type: FieldMatchType;
  canonical_property: string;
  canonical_value: string;
  event_validity: number | null;
}

export interface SourceAuthority {
  canonical_property: string;
  source: string;
  authority: number;
  event_ground_truth: boolean;
}

const FIELD_MAP_COLUMNS =
  'source, match_kind, source_key, match, match_type, canonical_property, canonical_value, event_validity';
const AUTHORITY_COLUMNS = 'canonical_property, source, authority, event_ground_truth';

/**
 * Load the field map for a workspace, global defaults + workspace overrides merged. A
 * workspace row wins over a global row with the same (source, source_key, match). Rows are
 * plain data — matching is done by the pure mapToCanonical below.
 */
export async function loadFieldMap(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<SourceFieldMap[]> {
  const { data, error } = await supabase
    .from('source_field_map')
    .select(FIELD_MAP_COLUMNS + ', workspace_id')
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  if (error) throw new Error(`failed to load field map: ${error.message}`);
  const rows = (data as unknown as (SourceFieldMap & { workspace_id: string | null })[]) ?? [];
  // Workspace override: drop a global row if a ws row covers the same key+match.
  const wsKeys = new Set(
    rows.filter(r => r.workspace_id).map(r => `${r.source}|${r.source_key}|${r.match ?? ''}`),
  );
  return rows
    .filter(r => r.workspace_id || !wsKeys.has(`${r.source}|${r.source_key}|${r.match ?? ''}`))
    .map(({ workspace_id: _w, ...r }) => r);
}

/**
 * Load the authority map for one canonical property as source -> {authority, eventGroundTruth}.
 * Workspace rows override global defaults.
 */
export async function loadAuthority(
  supabase: SupabaseClient,
  workspaceId: string,
  canonicalProperty: string,
): Promise<Record<string, { authority: number; eventGroundTruth: boolean }>> {
  const { data, error } = await supabase
    .from('source_authority')
    .select(AUTHORITY_COLUMNS + ', workspace_id')
    .eq('canonical_property', canonicalProperty)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  if (error) throw new Error(`failed to load authority: ${error.message}`);
  const rows = (data as unknown as (SourceAuthority & { workspace_id: string | null })[]) ?? [];
  const out: Record<string, { authority: number; eventGroundTruth: boolean }> = {};
  // Apply global first, then let workspace rows overwrite.
  for (const r of rows.filter(r => !r.workspace_id)) {
    out[r.source] = { authority: r.authority, eventGroundTruth: r.event_ground_truth };
  }
  for (const r of rows.filter(r => r.workspace_id)) {
    out[r.source] = { authority: r.authority, eventGroundTruth: r.event_ground_truth };
  }
  return out;
}

export interface CanonicalMatch {
  canonical_property: string;
  canonical_value: string;
  /** Validity factor (0..1) to carry as the projected observation's source_confidence. */
  event_validity: number;
}

/** Casefold + trim for value comparison. */
function norm(v: unknown): string {
  return v == null ? '' : String(v).trim().toLowerCase();
}

function matches(row: SourceFieldMap, rawValue: string): boolean {
  if (row.match_kind === 'event') return true; // event rows key on source_key alone
  const m = norm(row.match);
  if (m === '') return false;
  if (row.match_type === 'prefix') return rawValue.startsWith(m);
  if (row.match_type === 'regex') {
    try { return new RegExp(row.match as string, 'i').test(rawValue); } catch { return false; }
  }
  return rawValue === m; // 'eq'
}

/**
 * Pure: given a source's raw observation (kind's key + value) and the loaded field map,
 * return the canonical (property, value) it projects to, or null. `sourceKey` is the raw
 * state property (e.g. 'lifecycle_stage') for a state_field, or the event type
 * (e.g. 'invoice.paid') for an event.
 */
export function mapToCanonicalAxis(
  fieldMap: SourceFieldMap[],
  source: string,
  kind: FieldMapKind,
  sourceKey: string,
  rawValue?: unknown,
): CanonicalMatch | null {
  const key = norm(sourceKey);
  const val = norm(rawValue);
  for (const row of fieldMap) {
    if (norm(row.source) !== norm(source)) continue;
    if (row.match_kind !== kind) continue;
    if (norm(row.source_key) !== key) continue;
    if (!matches(row, val)) continue;
    return {
      canonical_property: row.canonical_property,
      canonical_value: row.canonical_value,
      event_validity: row.event_validity ?? 1.0,
    };
  }
  return null;
}
