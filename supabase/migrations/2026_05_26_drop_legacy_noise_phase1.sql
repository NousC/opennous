-- ============================================================================
-- Phase 1: Drop trivially-safe legacy v1 noise claims (soft-delete)
-- ============================================================================
--
-- The Phase 4 cutover migration claim-ified every v1 contacts/companies
-- column. After surveying the codebase (May 2026), five of those columns
-- have ZERO active writers AND ZERO active readers — they're pure cutover
-- residue surfacing as stale zeros and useless constants in /v2/context,
-- /v2/accounts, and the agent's prompt:
--
--   interaction_count            — never recomputed since backfill; always 0
--   incoming_contacts_count      — declared in TS Contact interface, unused
--   total_documents_count        — declared in TS Contact interface, unused
--   total_income_source          — constant string "manual", unused
--   pipeline_stage_updated_at    — redundant with claims.last_observed_at
--
-- Soft-delete (NOT hard delete) via the substrate convention: set
-- invalid_at = NOW() so getClaims (which filters invalid_at IS NULL) stops
-- returning them, but the rows stay auditable.
--
-- NOT TOUCHED IN PHASE 1 — these are active surfaces, refactor required:
--   enrichment_status   — live Apollo/Prospeo state machine
--   channels            — LinkedIn connection state machine
--   source              — provenance tracking, used in API filtering
--   pipeline_stage_source — decay cron uses to skip manual overrides
--   deal_health_score   — actively computed, sorted on in pipelines
--   tags, first_seen_at — need 5-minute API cleanup before drop (Phase 2)

-- Soft-delete the five trivially-safe properties across every workspace.
UPDATE claims
   SET invalid_at = NOW()
 WHERE invalid_at IS NULL
   AND property IN (
     'interaction_count',
     'incoming_contacts_count',
     'total_documents_count',
     'total_income_source',
     'pipeline_stage_updated_at'
   );

-- Verification — show per-property counts of rows we just invalidated.
-- Expected: one row per property, the count = number of entities that had
-- that claim. Zero means the column was already empty (no-op for that one).
SELECT property,
       COUNT(*) AS rows_invalidated
  FROM claims
 WHERE invalid_at >= NOW() - INTERVAL '5 minutes'
   AND property IN (
     'interaction_count',
     'incoming_contacts_count',
     'total_documents_count',
     'total_income_source',
     'pipeline_stage_updated_at'
   )
 GROUP BY property
 ORDER BY property;
