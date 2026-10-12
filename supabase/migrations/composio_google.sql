-- Composio integration layer — replaces the native Google OAuth routes + Gmail/Calendar
-- pollers as the per-user OAuth + ingestion layer for Gmail and Google Calendar.
--
-- A Composio connection stores NO secret on our box — Composio holds the OAuth token — so
-- `encrypted_credentials` is left empty ({}) for these rows and the connection is identified
-- by its Composio connected-account id instead. Push triggers are registered per connection;
-- we keep their ids so disconnect can tear them down.
--
-- All additive. Any pre-existing native connections keep managed_by='native'.

-- Which layer owns a provider's auth + ingestion: 'native' (our own OAuth routes / pollers /
-- key handlers) or 'composio'. The catalogue file is the source of truth; syncCatalogueToDb
-- projects p.managed into this column on every boot.
alter table workflow_providers
  add column if not exists managed_by text not null default 'native';

-- Per-connection Composio bookkeeping.
alter table workflow_provider_connections
  add column if not exists managed_by             text  not null default 'native',
  add column if not exists composio_connection_id text,            -- Composio connected-account id
  add column if not exists composio_trigger_ids   jsonb not null default '[]'::jsonb; -- trigger ids to revoke on disconnect

-- We look connections up by their Composio id in the trigger webhook path.
create index if not exists workflow_provider_connections_composio_idx
  on workflow_provider_connections (composio_connection_id)
  where composio_connection_id is not null;

-- Per-workspace Composio configuration (self-serve "paste your key" model).
--
-- A founder pastes their own Composio project API key into Nous, and the box auto-provisions
-- the Gmail + Calendar auth configs + webhook against it. The key lives HERE (data-plane, on
-- the customer's own Supabase), encrypted — never in the control plane. loadComposioConfig()
-- reads this row for the workspace, falling back to the COMPOSIO_* env vars when absent
-- (the DWY-provisioned path). Both models run off the same code.
--
-- encrypted_api_key + webhook_secret are AES-256-GCM encrypted (apps/api/src/providers/crypto.mjs).
-- authconfig_* + base_url are non-secret ids/URLs, stored plain.
create table if not exists workspace_composio_config (
  workspace_id              uuid primary key references workspaces(id) on delete cascade,
  encrypted_api_key         text,   -- the customer's Composio project key (encrypted)
  base_url                  text,   -- self-hosted Composio; null → Composio cloud
  webhook_secret            text,   -- project webhook signing secret (encrypted)
  authconfig_gmail          text,   -- Composio auth-config id for Gmail
  authconfig_googlecalendar text,   -- Composio auth-config id for Google Calendar
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
