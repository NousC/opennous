import type { SupabaseClient } from '@supabase/supabase-js';

// v2 → v1 overlay — OPEN substrate (part of the context graph). Extracted from entities.ts to
// keep the identity primitive pure, but it ships in the open context graph: it SURFACES the
// graph's own revenue-native fields (pipeline_stage, deal_health_score, deal_value) and the
// stored ICP score/prediction. It only READS substrate tables (claims, identifiers, predictions,
// relationships, observations) — zero product imports. The ICP scoring MODEL that computes the
// prediction stays CLOSED; this just surfaces whatever score is stored (null when no model ran).
//
// Phase 4a transitional read-path: every reader of `contacts` / `companies` fetches the v1 row,
// then overlays whatever the v2 substrate carries. Remaining v1-only columns still fall through.

export interface EntityOverlay {
  claims: Record<string, unknown>;
  identifiers: Record<string, string>;
  prediction: { score?: number; fit?: boolean; reason?: string } | null;
  latestObservedAt: string | null;
  worksAtCompanyId: string | null;
}

/** Batch-fetch v2 overlays for many entity ids. Empty entries are safe. */
export async function fetchEntityOverlays(
  supabase: SupabaseClient,
  entityIds: string[],
): Promise<Map<string, EntityOverlay>> {
  const map = new Map<string, EntityOverlay>();
  if (entityIds.length === 0) return map;
  for (const id of entityIds) {
    map.set(id, { claims: {}, identifiers: {}, prediction: null, latestObservedAt: null, worksAtCompanyId: null });
  }

  const [claimsRes, identsRes, predsRes, obsRes, relsRes] = await Promise.all([
    supabase.from('claims')
      .select('entity_id, property, value')
      .in('entity_id', entityIds)
      .is('invalid_at', null),
    supabase.from('entity_identifiers')
      .select('entity_id, kind, value')
      .in('entity_id', entityIds)
      .eq('status', 'active'),
    supabase.from('predictions')
      .select('entity_id, predicted_value, predicted_at')
      .in('entity_id', entityIds)
      .eq('kind', 'icp_fit')
      .order('predicted_at', { ascending: false }),
    supabase.from('observations')
      .select('entity_id, observed_at')
      .in('entity_id', entityIds)
      .order('observed_at', { ascending: false }),
    supabase.from('relationships')
      .select('from_entity_id, to_entity_id, type')
      .in('from_entity_id', entityIds)
      .eq('type', 'works_at')
      .is('valid_to', null),
  ]);

  for (const c of (claimsRes.data as { entity_id: string; property: string; value: unknown }[]) ?? []) {
    map.get(c.entity_id)!.claims[c.property] = c.value;
  }
  for (const i of (identsRes.data as { entity_id: string; kind: string; value: string }[]) ?? []) {
    map.get(i.entity_id)!.identifiers[i.kind] = i.value;
  }
  const seenPred = new Set<string>();
  for (const p of (predsRes.data as { entity_id: string; predicted_value: unknown }[]) ?? []) {
    if (seenPred.has(p.entity_id)) continue;
    seenPred.add(p.entity_id);
    map.get(p.entity_id)!.prediction = p.predicted_value as EntityOverlay['prediction'];
  }
  const seenObs = new Set<string>();
  for (const o of (obsRes.data as { entity_id: string; observed_at: string }[]) ?? []) {
    if (seenObs.has(o.entity_id)) continue;
    seenObs.add(o.entity_id);
    map.get(o.entity_id)!.latestObservedAt = o.observed_at;
  }
  for (const r of (relsRes.data as { from_entity_id: string; to_entity_id: string }[]) ?? []) {
    const o = map.get(r.from_entity_id)!;
    if (!o.worksAtCompanyId) o.worksAtCompanyId = r.to_entity_id;
  }

  return map;
}

/** Overlay v2 data onto a v1 contact row. Returns a new row; doesn't mutate. */
export function applyContactOverlay(
  row: Record<string, unknown>,
  overlay: EntityOverlay | undefined,
): Record<string, unknown> {
  if (!overlay) return row;
  const { claims, identifiers, prediction, latestObservedAt, worksAtCompanyId } = overlay;
  const pick = <T>(...candidates: T[]): T => {
    for (const c of candidates) if (c !== undefined && c !== null) return c;
    return candidates[candidates.length - 1];
  };
  return {
    ...row,
    // Identifiers
    email:              pick(identifiers.email,              row.email as unknown),
    linkedin_url:       pick(identifiers.linkedin_url,       row.linkedin_url as unknown),
    linkedin_member_id: pick(identifiers.linkedin_member_id, row.linkedin_member_id as unknown),
    hubspot_id:         pick(identifiers.hubspot,            row.hubspot_id as unknown),
    pipedrive_id:       pick(identifiers.pipedrive,          row.pipedrive_id as unknown),
    apollo_id:          pick(identifiers.apollo,             row.apollo_id as unknown),
    // Profile claims
    first_name:         pick(claims.first_name,              row.first_name),
    last_name:          pick(claims.last_name,               row.last_name),
    job_title:          pick(claims.job_title,               row.job_title),
    seniority:          pick(claims.seniority,               row.seniority),
    department:         pick(claims.department,              row.department),
    city:               pick(claims.city,                    row.city),
    country:            pick(claims.country,                 row.country),
    phone:              pick(claims.phone,                   row.phone),
    company:            pick(claims.company,                 row.company),
    photo_url:          pick(claims.photo_url,               row.photo_url),
    // Pipeline / lifecycle
    pipeline_stage:     pick(claims.pipeline_stage,          row.pipeline_stage),
    stage_locked:       pick(claims.stage_locked,            row.stage_locked),
    source:             pick(claims.source,                  row.source),
    first_seen_at:      pick(claims.first_seen_at,           row.first_seen_at as unknown),
    // Channels (LinkedIn / email state, JSONB)
    channels:           pick(claims.channels,                row.channels),
    // Relations
    company_id:         pick(worksAtCompanyId,               row.company_id as unknown),
    // Deal state
    deal_health_score:  pick(claims.deal_health_score,       row.deal_health_score),
    deal_stage:         pick(claims.deal_stage,              row.deal_stage),
    deal_value:         pick(claims.deal_value,              row.deal_value),
    // Enrichment process state
    enrichment_status:  pick(claims.enrichment_status,       row.enrichment_status),
    enriched_at:        pick(claims.enriched_at,             row.enriched_at as unknown),
    // LLM-derived summary
    memory_summary:     pick(claims.memory_summary,          row.memory_summary),
    // Scores (from the latest icp_fit prediction)
    icp_score:          pick(prediction?.score,              row.icp_score),
    icp_fit:            pick(prediction?.fit,                row.icp_fit),
    icp_reasoning:      pick(prediction?.reason,             row.icp_reasoning),
    // Derived from observations
    last_activity_at:   pick(latestObservedAt,               row.last_activity_at as unknown),
  };
}

/** Overlay v2 data onto a v1 company row. */
export function applyCompanyOverlay(
  row: Record<string, unknown>,
  overlay: EntityOverlay | undefined,
): Record<string, unknown> {
  if (!overlay) return row;
  const { claims, identifiers } = overlay;
  const pick = <T>(...candidates: T[]): T => {
    for (const c of candidates) if (c !== undefined && c !== null) return c;
    return candidates[candidates.length - 1];
  };
  return {
    ...row,
    name:               pick(claims.name,               row.name),
    domain:             pick(identifiers.domain,        row.domain as unknown),
    industry:           pick(claims.industry,           row.industry),
    employee_count:     pick(claims.employee_count,     row.employee_count),
    location:           pick(claims.location,           row.location),
    revenue_range:      pick(claims.revenue_range,      row.revenue_range),
    tech_stack:         pick(claims.tech_stack,         row.tech_stack),
    enrichment_status:  pick(claims.enrichment_status,  row.enrichment_status),
    enriched_at:        pick(claims.enriched_at,        row.enriched_at as unknown),
    deal_health_score:  pick(claims.deal_health_score,  row.deal_health_score),
    hubspot_company_id: pick(claims.hubspot_company_id, row.hubspot_company_id as unknown),
    apollo_account_id:  pick(claims.apollo_account_id,  row.apollo_account_id as unknown),
    // The account summary. The companies view has no column for it, so it lives only as
    // claims, written by the worker's company summary (GET-223).
    memory_summary:       pick(claims.memory_summary,       row.memory_summary),
    summary_generated_at: pick(claims.summary_generated_at, row.summary_generated_at as unknown),
  };
}
