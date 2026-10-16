import type { SupabaseClient } from '@supabase/supabase-js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ScorecardSignal } from '../types.js';
import type { StakeResult } from '../db/predictions.js';

// The learned ICP scorer's seam in core — GET-754 slice 8.
//
// A workspace's accounts are scored one of two ways (GET-586): by Nous's learned scorecard, or by
// the workspace's own model, posted in through POST /v2/scores. The learned scorecard is Nous
// Cloud's model and lives in src/cloud/ (the scorer, staking, re-scoring, signal discovery, the
// win-model fit), which the open-source export drops. Everything public that used to call it
// directly — ingest, enrichment, the claim engine, CRM hygiene — calls the functions below
// instead. With the cloud folder present they are the learned scorer, unchanged. Without it there
// is no Nous score to stake or refresh, so they do nothing, and the workspace is scored only by
// what it posts (db/externalScores.ts treats every workspace as 'external').
//
// This file and services/cloudRequestedFeatures.ts are the only places in core that reach into
// src/cloud/, and they check the folder exists first (scripts/check-cloud-imports.mjs keeps every
// other public file out of it). It loads lazily, on first use, so nothing here runs at import time.

export interface RescoreResult {
  rescored: number;       // open predictions whose score actually moved
  restamped: number;      // model changed but this account's score didn't
  version: string | null; // the model fingerprint everything is now at
}

export interface EntityRescoreResult {
  status: 'rescored' | 'restamped' | 'no_open_prediction' | 'not_scoreable' | 'no_model' | 'external';
  from?: number | null;
  to?: number | null;
}

export interface LeadScore {
  score: number;                                  // 0–100
  raw: number;                                    // summed weights, pre-rescale
  fired: { key: string; weight: number }[];       // the signals that fired (+ or −)
  excluded: { key: string }[];                    // disqualifying rules that fired
}

/** What a learned scorer provides. src/cloud/index.ts exports Nous's as `learnedIcpScorer`. */
export interface LearnedIcpScorer {
  scoreAndStake(supabase: SupabaseClient, workspaceId: string, entityId: string, signals: ScorecardSignal[]): Promise<StakeResult | null>;
  rescoreEntityFromClaims(supabase: SupabaseClient, workspaceId: string, entityId: string, opts?: { signals?: ScorecardSignal[]; now?: number }): Promise<EntityRescoreResult>;
  rescoreCompanyMembers(supabase: SupabaseClient, workspaceId: string, companyEntityId: string, opts?: { signals?: ScorecardSignal[]; now?: number }): Promise<{ members: number; rescored: number }>;
  rescoreOpenPredictions(supabase: SupabaseClient, workspaceId: string, opts?: { limit?: number; now?: number; force?: boolean }): Promise<RescoreResult>;
  /** Pure: score a feature map against a signal list. */
  scoreLead(features: Record<string, unknown> | null | undefined, signals: ScorecardSignal[]): LeadScore;
  /** Pure: the fingerprint of the active model, stamped on every prediction it scores. */
  modelVersion(signals: ScorecardSignal[]): string;
}

const CLOUD_ENTRY = new URL('../cloud/index.js', import.meta.url);
const HAS_CLOUD_SCORER = existsSync(fileURLToPath(CLOUD_ENTRY));

let registered: LearnedIcpScorer | null = null;
let loading: Promise<LearnedIcpScorer | null> | null = null;

/** Plug in a learned scorer by hand. Without one, the cloud folder's is used when it exists. */
export function registerIcpScorer(scorer: LearnedIcpScorer | null): void {
  registered = scorer;
  loading = null;
}

/** True when a learned scorer is available: this build carries src/cloud/, or one was registered. */
export function hasLearnedIcpScorer(): boolean {
  return !!registered || HAS_CLOUD_SCORER;
}

/** The learned scorer, or null on an open-source build. Loaded once. */
export function learnedIcpScorer(): Promise<LearnedIcpScorer | null> {
  if (registered) return Promise.resolve(registered);
  loading ??= HAS_CLOUD_SCORER
    ? import(CLOUD_ENTRY.href).then(
        (m: { learnedIcpScorer: LearnedIcpScorer }) => m.learnedIcpScorer,
        (e: unknown) => {
          // Loud on purpose: the folder exists, so this is Cloud, and a swallowed failure here
          // would stop scoring silently. Forget the failed load so the next call retries.
          console.error('[icpScorer] loading the learned scorer failed', e);
          loading = null;
          throw e;
        },
      )
    : Promise.resolve(null);
  return loading;
}

// ── The learned scorer's entry points, as public code calls them ─────────────────────────────

/** Score one entity and stake an icp_fit prediction. null when nothing was staked. */
export async function scoreAndStake(
  supabase: SupabaseClient, workspaceId: string, entityId: string, signals: ScorecardSignal[],
): Promise<StakeResult | null> {
  const s = await learnedIcpScorer();
  return s ? s.scoreAndStake(supabase, workspaceId, entityId, signals) : null;
}

/** Refresh an entity's open prediction from its current claims. Without a learned scorer: 'external'. */
export async function rescoreEntityFromClaims(
  supabase: SupabaseClient, workspaceId: string, entityId: string,
  opts: { signals?: ScorecardSignal[]; now?: number } = {},
): Promise<EntityRescoreResult> {
  const s = await learnedIcpScorer();
  return s ? s.rescoreEntityFromClaims(supabase, workspaceId, entityId, opts) : { status: 'external' };
}

/** Re-score every person at a company after a company-level change. */
export async function rescoreCompanyMembers(
  supabase: SupabaseClient, workspaceId: string, companyEntityId: string,
  opts: { signals?: ScorecardSignal[]; now?: number } = {},
): Promise<{ members: number; rescored: number }> {
  const s = await learnedIcpScorer();
  return s ? s.rescoreCompanyMembers(supabase, workspaceId, companyEntityId, opts) : { members: 0, rescored: 0 };
}

/** Re-score every open prediction after the model changed. */
export async function rescoreOpenPredictions(
  supabase: SupabaseClient, workspaceId: string,
  opts: { limit?: number; now?: number; force?: boolean } = {},
): Promise<RescoreResult> {
  const s = await learnedIcpScorer();
  return s ? s.rescoreOpenPredictions(supabase, workspaceId, opts) : { rescored: 0, restamped: 0, version: null };
}
