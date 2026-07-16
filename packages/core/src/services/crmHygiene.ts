// CRM hygiene — propose-only reconciliation between the customer graph and the
// CRM. The engine (worker) computes proposed changes; these helpers persist and
// read them. Nothing here writes to a CRM — a proposal becomes a CRM write only
// after a human approves it (Phase 2). See docs/crm-sync.md.

import type { SupabaseClient } from '@supabase/supabase-js';
import { listSignals } from '../db/scorecard.js';
import { scoreAndStake } from '../db/predictions.js';
import { logWorkerRun } from '../db/workerRuns.js';
import { getClaimsForReconcile } from '../db/claims.js';
import { evaluateProvenance } from './crmProvenance.js';
import { decideReconcile, isSuppressedByRejection, RECONCILE_PROPERTIES } from './crmReconcile.js';
import { fetchCrmRecordFields, type CrmProvider, type CrmRecordFields } from '../integrations/crm/index.js';

export type HygieneKind =
  | 'field_fill'      // CRM field empty, we have a claim → fill
  | 'field_update'    // CRM value differs from a fresher/evidence-backed claim
  | 'conflict'        // CRM holds a human value that disagrees → flagged, never silently overwritten
  | 'net_new'         // a record we didn't create → enriched + scored, fold into the graph
  | 'icp_rescore'     // ICP score/fit to write back
  | 'milestone_sync'; // a high-signal milestone missing from the record

export type HygieneStatus = 'proposed' | 'approved' | 'applied' | 'dismissed' | 'failed';

export interface HygieneProposalInput {
  workspaceId: string;
  runId?: string | null;
  provider: string;
  entityId?: string | null;
  crmRecordId?: string | null;
  kind: HygieneKind;
  field?: string | null;
  currentValue?: unknown;
  proposedValue?: unknown;
  evidence?: Record<string, unknown> | null;
  confidence?: number | null;
  reason?: string | null;
}

export interface HygieneProposalRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  provider: string;
  entity_id: string | null;
  crm_record_id: string | null;
  kind: HygieneKind;
  field: string | null;
  current_value: unknown;
  proposed_value: unknown;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  reason: string | null;
  status: HygieneStatus;
  created_at: string;
  applied_at: string | null;
  updated_at: string;
}

// Which CRM field maps to which graph claim. Behavior is enforced by the engine;
// this is the shared contract the reconcile pass (Phase 1b) and the UI read from.
export const HYGIENE_FIELD_MAP: { field: string; claim: string; behavior: 'fill_or_update' | 'fill_only' }[] = [
  { field: 'job_title',      claim: 'job_title',      behavior: 'fill_or_update' },
  { field: 'seniority',      claim: 'seniority',      behavior: 'fill_or_update' },
  { field: 'company',        claim: 'company',        behavior: 'fill_or_update' },
  { field: 'industry',       claim: 'industry',       behavior: 'fill_or_update' },
  { field: 'employee_count', claim: 'employee_count', behavior: 'fill_only' },
  { field: 'linkedin_url',   claim: 'linkedin_url',   behavior: 'fill_only' },
  { field: 'phone',          claim: 'phone',          behavior: 'fill_only' },
];

/** Insert a batch of proposals. Returns the number written. */
export async function insertHygieneProposals(
  supabase: SupabaseClient,
  rows: HygieneProposalInput[],
): Promise<number> {
  if (!rows.length) return 0;
  const payload = rows.map(r => ({
    workspace_id:   r.workspaceId,
    run_id:         r.runId ?? null,
    provider:       r.provider,
    entity_id:      r.entityId ?? null,
    crm_record_id:  r.crmRecordId ?? null,
    kind:           r.kind,
    field:          r.field ?? null,
    current_value:  r.currentValue ?? null,
    proposed_value: r.proposedValue ?? null,
    evidence:       r.evidence ?? null,
    confidence:     r.confidence ?? null,
    reason:         r.reason ?? null,
  }));
  const { error } = await supabase.from('crm_hygiene_proposals').insert(payload);
  if (error) {
    console.error('[CRM_HYGIENE] proposal insert failed:', error.message);
    return 0;
  }
  return payload.length;
}

/** True if this entity already has an open (proposed) proposal of this kind — used to avoid re-proposing each run. */
export async function hasOpenProposal(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  kind: HygieneKind,
  field?: string | null,
): Promise<boolean> {
  let q = supabase
    .from('crm_hygiene_proposals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('kind', kind)
    .eq('status', 'proposed');
  if (field) q = q.eq('field', field);
  const { count } = await q;
  return (count ?? 0) > 0;
}

export async function listHygieneProposals(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { status?: HygieneStatus; provider?: string; limit?: number } = {},
): Promise<HygieneProposalRow[]> {
  let q = supabase
    .from('crm_hygiene_proposals')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (opts.status)   q = q.eq('status', opts.status);
  if (opts.provider) q = q.eq('provider', opts.provider);
  q = q.limit(opts.limit ?? 100);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HygieneProposalRow[];
}

/** Count proposals by status for the workspace (for the report header). */
export async function countHygieneProposals(
  supabase: SupabaseClient,
  workspaceId: string,
  status: HygieneStatus = 'proposed',
): Promise<number> {
  const { count } = await supabase
    .from('crm_hygiene_proposals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('status', status);
  return count ?? 0;
}

/**
 * Update a proposal's status. v1 supports 'approved' and 'dismissed' — both are
 * decisions, neither writes to the CRM yet (Phase 2 applies 'approved' rows and
 * sets 'applied'). Scoped to the workspace so RLS-bypassing service callers
 * can't cross workspaces by id alone.
 */
export async function updateHygieneProposalStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  status: HygieneStatus,
): Promise<HygieneProposalRow | null> {
  const patch: Record<string, unknown> = { status };
  if (status === 'applied') patch.applied_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('crm_hygiene_proposals')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as HygieneProposalRow) ?? null;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
// Propose-only. Enrich + score are internal graph writes (done now); CRM changes
// are written as proposals. The enrich function is injected because the worker
// and the API each have their own (apps/* can't be imported into core).

const PROVIDERS = ['hubspot', 'pipedrive', 'attio'];
const ID_COLUMN: Record<string, string> = { hubspot: 'hubspot_id', pipedrive: 'pipedrive_id', attio: 'attio_id' };
const NET_NEW_LIMIT = 25;
const ICP_LIMIT = 100;
const RECONCILE_CANDIDATE_LIMIT = 100;  // entities reconciled per run (bounded — see telemetry)
const RECONCILE_THROTTLE_MS = 120;      // gap between per-record CRM GETs (HubSpot ~10/s)

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

export interface HygieneConfigRow {
  id: string;
  workspace_id: string;
  provider: string;
  hygiene_cadence?: string | null;
  hygiene_last_run_at?: string | null;
}

export interface HygieneDeps {
  /** Enrich (and internally score) a contact row. Injected per app. */
  enrich: (supabase: SupabaseClient, contact: Record<string, unknown>) => Promise<unknown>;
  /** Decrypted CRM token. When present, the read-only reconcile pass runs. */
  crmToken?: string | null;
}

/** True if a config is due to run, given its cadence and last run. */
export function hygieneDue(cfg: HygieneConfigRow, nowMs: number): boolean {
  if (!cfg.hygiene_last_run_at) return true;
  const days = (nowMs - new Date(cfg.hygiene_last_run_at).getTime()) / 86_400_000;
  return cfg.hygiene_cadence === 'monthly' ? days >= 28 : days >= 7;
}

async function logSysEvent(
  supabase: SupabaseClient, workspaceId: string, source: string, eventType: string,
  summary: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source, event_type: eventType, summary,
      metadata, occurred_at: new Date().toISOString(),
    });
  } catch { /* non-critical telemetry */ }
}

async function runNetNew(supabase: SupabaseClient, cfg: HygieneConfigRow, deps: HygieneDeps): Promise<{ count: number; entityIds: Set<string> }> {
  const provider = cfg.provider;
  const idCol = ID_COLUMN[provider];
  const seen = new Set<string>();

  const { data: candidates } = await supabase
    .from('contacts')
    .select(`id, workspace_id, email, linkedin_url, job_title, company, seniority, icp_score, icp_fit, enrichment_status, ${idCol}`)
    .eq('workspace_id', cfg.workspace_id)
    .eq('source', provider)
    .not(idCol, 'is', null)
    .or('enrichment_status.is.null,enrichment_status.eq.none,enrichment_status.eq.failed,icp_score.is.null')
    .limit(NET_NEW_LIMIT);

  if (!candidates?.length) return { count: 0, entityIds: seen };

  let signals: Awaited<ReturnType<typeof listSignals>> | null = null;
  const rows: HygieneProposalInput[] = [];

  for (const c of candidates as Record<string, any>[]) {
    try {
      if (c.enrichment_status === 'complete') {
        if (signals === null) signals = await listSignals(supabase, cfg.workspace_id, { activeOnly: true });
        if (signals.length) await scoreAndStake(supabase, cfg.workspace_id, c.id, signals).catch(() => null);
      } else {
        await deps.enrich(supabase, c);   // enriches + scores internally
      }
    } catch (err: any) {
      console.error('[CRM_HYGIENE] net_new enrich failed', c.id, err?.message || err);
      continue;
    }
    if (await hasOpenProposal(supabase, cfg.workspace_id, c.id, 'net_new')) continue;

    const { data: fresh } = await supabase
      .from('contacts')
      .select('job_title, company, seniority, icp_score, icp_fit')
      .eq('id', c.id)
      .maybeSingle();
    const f = (fresh as Record<string, any>) || c;

    rows.push({
      workspaceId: cfg.workspace_id, runId: null, provider, entityId: c.id, crmRecordId: c[idCol],
      kind: 'net_new',
      reason: `Record added to ${provider} outside Nous — enriched and scored. Propose pushing the result back.`,
      proposedValue: {
        job_title: f.job_title ?? null, company: f.company ?? null, seniority: f.seniority ?? null,
        nous_icp_score: f.icp_score ?? null, nous_icp_fit: f.icp_fit ?? null,
      },
      confidence: typeof f.icp_score === 'number' ? f.icp_score / 100 : null,
    });
    seen.add(c.id);
  }

  const count = await insertHygieneProposals(supabase, rows);
  return { count, entityIds: seen };
}

async function runIcpRescore(supabase: SupabaseClient, cfg: HygieneConfigRow, exclude: Set<string>): Promise<number> {
  const provider = cfg.provider;
  const idCol = ID_COLUMN[provider];

  const { data: scored } = await supabase
    .from('contacts')
    .select(`id, icp_score, icp_fit, icp_reasoning, ${idCol}`)
    .eq('workspace_id', cfg.workspace_id)
    .not(idCol, 'is', null)
    .not('icp_score', 'is', null)
    .limit(ICP_LIMIT);

  if (!scored?.length) return 0;

  const rows: HygieneProposalInput[] = [];
  for (const c of scored as Record<string, any>[]) {
    if (exclude.has(c.id)) continue;
    if (await hasOpenProposal(supabase, cfg.workspace_id, c.id, 'icp_rescore', 'nous_icp_score')) continue;
    rows.push({
      workspaceId: cfg.workspace_id, runId: null, provider, entityId: c.id, crmRecordId: c[idCol],
      kind: 'icp_rescore', field: 'nous_icp_score', currentValue: null,
      proposedValue: { nous_icp_score: c.icp_score, nous_icp_fit: c.icp_fit, nous_icp_reason: c.icp_reasoning ?? null },
      confidence: typeof c.icp_score === 'number' ? c.icp_score / 100 : null,
      reason: `ICP fit ${c.icp_score} — propose writing to ${provider}.`,
    });
  }
  return insertHygieneProposals(supabase, rows);
}

// ─── Field reconcile (Phase 1b) ──────────────────────────────────────────────
// Read-only against the CRM (GET only). For one entity: read the CRM's current
// values, compare each reconciled field's claim via the provenance gate + the
// pure decision fn, and queue any proposed change. Composes Task 0–2.

async function reconcileEntity(
  supabase: SupabaseClient,
  ctx: { workspaceId: string; provider: string; token: string; entityId: string; crmRecordId: string; runId?: string | null },
): Promise<number> {
  const { workspaceId, provider, token, entityId, crmRecordId } = ctx;

  const crmFields = await fetchCrmRecordFields(provider as CrmProvider, token, crmRecordId);
  if (!crmFields) return 0;  // record gone from the CRM

  // Only properties this provider exposes as a standard field are reconcilable.
  const props = RECONCILE_PROPERTIES.filter(p => p in crmFields);
  if (!props.length) return 0;

  const claims = await getClaimsForReconcile(supabase, workspaceId, entityId, props);
  const byProp = new Map(claims.map(c => [c.property, c]));

  const rows: HygieneProposalInput[] = [];
  for (const prop of props) {
    const claim = byProp.get(prop);
    if (!claim) continue;

    const provenance = await evaluateProvenance(supabase, workspaceId, claim.supporting_observation_ids);
    const decision = decideReconcile({
      field: prop, claim, crmValue: (crmFields as CrmRecordFields)[prop as keyof CrmRecordFields], provenance,
    });
    if (!decision) continue;

    // Don't re-raise an open proposal, and honour rejection memory.
    if (await hasOpenProposal(supabase, workspaceId, entityId, decision.kind, prop)) continue;
    if (await isSuppressedByRejection(supabase, workspaceId, provider, entityId, prop, decision.proposedValue)) continue;

    rows.push({
      workspaceId, runId: ctx.runId ?? null, provider, entityId, crmRecordId,
      kind: decision.kind, field: prop,
      currentValue: decision.currentValue, proposedValue: decision.proposedValue,
      evidence: { observations: decision.evidence, best_source: provenance.bestSource },
      confidence: decision.confidence, reason: decision.reason,
    });
  }
  return insertHygieneProposals(supabase, rows);
}

// Watermark-incremental: only entities with reconciled-field observations since
// the last run are candidates (never a full scan). Bounded + throttled to
// respect provider rate limits; the dropped remainder is logged, not silent.
async function runReconcilePass(
  supabase: SupabaseClient,
  ctx: { workspaceId: string; provider: string; token: string; since: string | null },
): Promise<{ proposed: number; scanned: number; capped: boolean }> {
  const { workspaceId, provider, token, since } = ctx;
  const idCol = ID_COLUMN[provider];

  let q = supabase
    .from('observations')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .in('property', RECONCILE_PROPERTIES as unknown as string[])
    .order('ingested_at', { ascending: false })
    .limit(RECONCILE_CANDIDATE_LIMIT * 4);   // over-fetch; dedups to entities below
  if (since) q = q.gte('ingested_at', since);
  const { data: obsRows } = await q;

  const entityIds = [...new Set((obsRows ?? []).map((r: any) => r.entity_id))];
  const capped = entityIds.length > RECONCILE_CANDIDATE_LIMIT;
  const candidates = entityIds.slice(0, RECONCILE_CANDIDATE_LIMIT);
  if (!candidates.length) return { proposed: 0, scanned: 0, capped: false };

  // Only reconcile entities already linked to THIS CRM.
  const { data: linked } = await supabase
    .from('contacts')
    .select(`id, ${idCol}`)
    .eq('workspace_id', workspaceId)
    .in('id', candidates)
    .not(idCol, 'is', null);

  let proposed = 0, scanned = 0;
  for (const c of (linked ?? []) as Record<string, any>[]) {
    scanned++;
    try {
      proposed += await reconcileEntity(supabase, { workspaceId, provider, token, entityId: c.id, crmRecordId: c[idCol] });
    } catch (err: any) {
      console.error('[CRM_HYGIENE] reconcile failed', c.id, err?.message || err);
    }
    await sleep(RECONCILE_THROTTLE_MS);
  }
  return { proposed, scanned, capped };
}

/** Run hygiene for one CRM config. Propose-only. Updates hygiene_last_run_at + telemetry. */
export async function runHygieneForConfig(
  supabase: SupabaseClient,
  cfg: HygieneConfigRow,
  deps: HygieneDeps,
): Promise<{ net_new: number; icp_rescore: number; reconcile: number } | null> {
  if (!PROVIDERS.includes(cfg.provider)) return null;
  const startedAt = new Date();

  // Capture the watermark BEFORE it advances — reconcile only looks at field
  // observations ingested since the previous run.
  const since = cfg.hygiene_last_run_at ?? null;

  const net = await runNetNew(supabase, cfg, deps);
  const icp = await runIcpRescore(supabase, cfg, net.entityIds);

  let reconcile = { proposed: 0, scanned: 0, capped: false };
  if (deps.crmToken) {
    reconcile = await runReconcilePass(supabase, {
      workspaceId: cfg.workspace_id, provider: cfg.provider, token: deps.crmToken, since,
    });
  }

  await supabase.from('crm_sync_configs')
    .update({ hygiene_last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', cfg.id);

  const summary = `${cfg.provider} hygiene — ${net.count} net-new enriched, ${icp} ICP write-backs, ` +
    `${reconcile.proposed} field changes proposed (${reconcile.scanned} reconciled${reconcile.capped ? `, capped at ${RECONCILE_CANDIDATE_LIMIT}` : ''})`;
  await logSysEvent(supabase, cfg.workspace_id, cfg.provider, 'hygiene_complete', summary,
    { net_new: net.count, icp_rescore: icp, reconcile_proposed: reconcile.proposed, reconcile_scanned: reconcile.scanned, reconcile_capped: reconcile.capped });
  await logWorkerRun(supabase, {
    worker: 'crm_hygiene', workspaceId: cfg.workspace_id, status: 'success',
    summary, details: { provider: cfg.provider, config_id: cfg.id, net_new: net.count, icp_rescore: icp, reconcile: reconcile.proposed },
    startedAt,
  });

  return { net_new: net.count, icp_rescore: icp, reconcile: reconcile.proposed };
}
