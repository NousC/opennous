-- "Open in HubSpot" (workspace redesign, Oct 2026).
--
-- A HubSpot record link needs the portal (account) id and the UI domain the portal lives on, and
-- we kept neither. The domain is not always app.hubspot.com: some portals are
-- on app-na3.hubspot.com and EU portals are on app-eu1, so a hard-coded host lands on a login page.
-- The CRM sync learns both once per connection from GET /account-info/v3/details
-- (ensureHubspotPortal in packages/core/src/integrations/crm/portal.ts) and keeps them here.
--
-- Additive and nullable: every existing reader and writer of crm_sync_configs is unaffected, and
-- the code treats a missing column or a NULL as "no link yet". Safe to re-run.
alter table public.crm_sync_configs
  add column if not exists crm_portal_id text,
  add column if not exists crm_ui_domain text;

comment on column public.crm_sync_configs.crm_portal_id is
  'The CRM account id (HubSpot portalId), learned by the sync; used only to build record links.';
comment on column public.crm_sync_configs.crm_ui_domain is
  'The host the CRM UI serves this account on (HubSpot uiDomain, e.g. app-na3.hubspot.com).';
