-- Security fix (audit C1): enable RLS (deny-all — no policy) on the 35 public tables that had it OFF.
-- anon/authenticated hold blanket DML grants, so with RLS off these were anon read/write via PostgREST
-- (confirmed live: audit_log, credit_grants, team_join_tokens [an auth-bypass credential],
-- source_authority [writable], the ri_* layer; workspace_secrets/stripe_connections open). RLS-on with
-- no policy denies anon/authenticated; service_role (BYPASSRLS) is unaffected so the app keeps full
-- access. Verified: anon read -> [], anon insert -> 401, service_role -> full.
--
-- Guarded (GET-757): several of these tables were created out-of-band on production and have no
-- CREATE TABLE in this repo (campaign_briefs, credit_grants, objection_handlers, ...). Unguarded, the
-- first missing one aborted the whole file on a fresh database, so NONE of the tables that do exist
-- got RLS. On production every table exists and this does exactly what the unguarded list did.
do $$
declare t text;
begin
  foreach t in array array[
    'audit_log',
    'campaign_briefs',
    'campaign_stats',
    'credit_autotopup',
    'credit_grants',
    'entity_merge_log',
    'field_conflicts',
    'flags',
    'identity_proposals',
    'llm_usage',
    'objection_handlers',
    'operator_outreach',
    'ri_behaviors',
    'ri_decision_traces',
    'ri_engine_runs',
    'ri_global_priors',
    'ri_observation_versions',
    'ri_observations',
    'ri_playbooks',
    'ri_recommendations',
    'source_authority',
    'source_field_map',
    'stripe_connections',
    'team_accounts_grace',
    'team_join_tokens',
    'unibox_draft_agent',
    'unibox_labels',
    'workspace_audit_snapshots',
    'workspace_features',
    'workspace_icp_model',
    'workspace_secrets',
    'workspace_skill_files',
    'workspace_skill_references',
    'workspace_stages',
    'workspace_webhook_subscriptions'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;
