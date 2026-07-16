# Supabase migrations

`schema.sql` in the parent directory is the **complete schema** — fresh self-hosters can run it once and get the latest state. Files here are **incremental migrations** for existing deployments that have an older schema applied.

## When to run which

- **Fresh install** → run `../schema.sql` once in the Supabase SQL editor. Done.
- **Existing install** → run the migration files in date order. They're all idempotent (`IF NOT EXISTS` guards), so running one twice is safe.

## How to run

Paste each file into the Supabase SQL editor and click Run. Or via psql:

```bash
psql "$DATABASE_URL" -f supabase/migrations/<file>.sql
```

## Migration log

| Date | File | What it adds |
|---|---|---|
| 2026-05-18 | `2026_05_18_add_salesforce_provider.sql` | Seeds the `salesforce` row in `workflow_providers` so the OAuth flow can resolve a provider_id |
| 2026-05-18 | `2026_05_18_crm_activity_push.sql` | Identity-cache columns (`pipedrive_id`, `attio_id`, `salesforce_id`) on `contacts` + `push_activities` toggle on `crm_sync_configs` |
| 2026-05-18 | `2026_05_18_crm_push_idempotency.sql` | `pushed_to_crms` JSONB on `contact_activity_log` to prevent duplicate engagements |
| 2026-05-19 | `2026_05_19_clamp_last_activity_future.sql` | Clamps `contacts.last_activity_at` to now() in the recompute trigger + backfills rows poisoned with future dates |
| 2026-05-19 | `2026_05_19_clamp_last_activity_future_v2.sql` | Follow-up: makes the trigger **skip** future-dated rows instead of clamping (clamping pushed poisoned contacts to the very top of "Today"); re-backfills using only past-or-present activity |
| 2026-05-19 | `2026_05_19_billing_v2.sql` | New billing model: `teams` columns (`stripe_customer_id`, `ops_monthly_used`, `ops_topup_balance`, `ops_period_start`); new tables `subscriptions`, `op_ledger`, `op_pack_purchases`. Backfills legacy `ops_balance` → `ops_topup_balance` and migrates Lifetime/legacy `plan_name` rows → comp Scale. Legacy column drops deferred to a follow-up. |
| 2026-05-20 | `2026_05_20_mind_episodes.sql` | The Mind — `mind_episodes` prediction/outcome ledger. Records every ICP prediction with the `workspace_memories` versions that produced it; `outcome_*` columns are filled in later by an outcome job. Phase 1 of docs/compound-intelligence-mind.md. |
| 2026-05-20 | `2026_05_20_lead_lists.sql` | Adaptive Lead Scoring (Phase 4a) — `lead_lists`, `leads`, `lead_suppressions` tables + `workspaces.icp_text`. Leads are the cold outreach universe, kept separate from `contacts`; the `leads` table is the evidence set. See docs/adaptive-lead-scoring.md. |
| 2026-05-20 | `2026_05_20_scorecard.sql` | Adaptive Lead Scoring (Phase 4b) — `scorecard_signals` (weighted signals that score a lead) + `scorecard_runs` (learning-loop log). See docs/adaptive-lead-scoring.md. |
| 2026-05-21 | `2026_05_21_mind_episode_features.sql` | Adaptive Lead Scoring (Phase 4c) — `mind_episodes.features` JSONB. Point-in-time feature snapshot the learning loop re-scores predictions against. See docs/adaptive-lead-scoring.md. |
| 2026-05-21 | `2026_05_21_lead_list_columns.sql` | Lists — `lead_lists.columns` (user-defined column definitions) + `leads.fields` (per-lead values for them). Lets each list be a small table the user shapes. |
| 2026-05-25 | `2026_05_25_worker_runs.sql` | Transparency — `worker_runs` table. Every nightly/periodic worker (mind_outcomes, scorecard_loop, claim_engine, score_entities, crm_sync, lead_replies, embeddings, pipeline_decay) writes a row after each invocation so the Intelligence page's "Loop activity" pill can show whether the compound loop is alive. |
| 2026-05-25 | `2026_05_25_decay_pipeline_stages_v2.sql` | Bugfix — rewrites the `decay_pipeline_stages()` RPC for v2. The original v1 version read the dropped `contact_activity_log` and UPDATEd the now-view-backed `contacts`, so the nightly 03:00 UTC cron silently failed (`relation "contact_activity_log" does not exist`). Replacement reads `observations` (property LIKE 'interaction.*') and writes a state observation; the claim engine recomputes `pipeline_stage` within a minute. |
| 2026-05-26 | `2026_05_26_add_emailbison_provider.sql` | Seeds the `emailbison` row in `workflow_providers` so the connect flow can resolve a provider_id |
| 2026-05-26 | `2026_05_26_add_heyreach_smartlead_providers.sql` | Seeds `heyreach` + `smartlead` rows in `workflow_providers` |
| 2026-07-13 | `2026_07_13_active_accounts.sql` | Billing meter — `active_account_interaction_properties()` + `team_active_accounts()` functions + `team_accounts_grace` table |
| 2026-07-13 | `2026_07_13_agent_routines.sql` | `agent_routines` + `agent_routine_runs` — scheduled agent work and its run/idempotency ledger |
| 2026-07-13 | `2026_07_13_llm_usage.sql` | `llm_usage` — per-workspace, per-call model cost accounting |
| 2026-07-13 | `2026_07_13_pending_actions.sql` | `pending_actions` — agent-proposed messages awaiting human approval |
| 2026-07-13 | `2026_07_13_provider_auth_type.sql` | Normalises `workflow_providers.auth_type` + tightens its CHECK; disables un-mounted providers |
| 2026-07-15 | `2026_07_15_audit_snapshots.sql` | `workspace_audit_snapshots` — nightly audit-sweep history for regression detection |
| 2026-07-15 | `2026_07_15_provider_setup_metadata.sql` | `workflow_providers` connect-form columns (`key_url`, `key_hint`, `webhook_mode`, `webhook_settings_url`) |

> Not every file between 2026-05-26 and 2026-07-13 is logged above; the files in this folder are the source of truth. The 2026-07-13/07-15 files were consolidated here from a former top-level `migrations/` folder so the documented update flow (this folder) surfaces them.

Each migration is also reflected in `../schema.sql` so a fresh install never needs to touch this folder.
