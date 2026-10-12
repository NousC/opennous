-- Which companies the CRM sync reads, per workspace (2026-10-06).
--
--   all                   every company in the portal (default, unchanged behaviour)
--   customers_and_deals   only customers, churned customers, and companies with any deal
--
-- A large portal can hold many times more companies than the account work needs. A bulk update
-- that stamps more companies with the same second than one HubSpot search window holds (10,000)
-- freezes the sync cursor there, and every company changed since is never read
-- (customer MRR, usage and churn flags included). Reading only the companies that matter clears it.
--
-- The sync reads this column defensively: before this migration runs, every workspace reads `all`.
-- Apply by hand in the Supabase SQL editor, like the other crm_sync_configs migrations.

alter table crm_sync_configs
  add column if not exists company_scope text not null default 'all';

do $$ begin
  alter table crm_sync_configs
    add constraint crm_sync_configs_company_scope_check
    check (company_scope in ('all', 'customers_and_deals'));
exception when duplicate_object then null; end $$;

-- That customer: customers, churned customers and any company with a deal.
-- Applied to prod 2026-10-06 for one customer workspace; intentionally a no-op in the repo (GET-761).
-- update crm_sync_configs
--    set company_scope = 'customers_and_deals'
--  where workspace_id = '<workspace-id>'
--    and provider = 'hubspot';
