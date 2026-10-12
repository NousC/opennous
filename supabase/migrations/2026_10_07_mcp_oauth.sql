-- OAuth 2.1 for the hosted MCP server (GET-762).
--
-- Lets Grok, Claude.ai, ChatGPT and other MCP clients add OpenNous by pasting
-- https://mcp.opennous.cloud/mcp and signing in, instead of pasting a pk_ key.
--
-- Model: approving a client mints an ordinary api_keys row (oauth_client_id set),
-- scoped exactly like a key the user would create themselves. The raw pk_ key is
-- never issued. The client holds short-lived access tokens (nat_) and rotating
-- refresh tokens (nrt_) that point at that key, so permissions are identical by
-- construction and revoking the key (Settings > API keys) cuts the client off.

-- Clients registered through RFC 7591 dynamic client registration. Public
-- clients only: PKCE is the proof, there is no client secret.
create table if not exists oauth_clients (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null unique,
  client_name    text,
  redirect_uris  text[] not null,
  created_at     timestamptz not null default now()
);

-- One row per /authorize call. Holds the pending request the consent screen
-- reads, then the hashed authorization code once the user approves.
create table if not exists oauth_authorization_requests (
  id              uuid primary key default gen_random_uuid(),
  request_id      text not null unique,      -- opaque handle in the consent URL
  client_id       text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri    text not null,
  state           text,
  code_challenge  text not null,             -- S256 only
  scope           text,
  resource        text,
  status          text not null default 'pending', -- pending | approved | denied | used
  workspace_id    uuid references workspaces(id) on delete cascade,
  api_key_id      uuid references api_keys(id) on delete cascade,
  code_hash       text unique,               -- sha256 of the authorization code
  created_at      timestamptz not null default now(),
  approved_at     timestamptz,
  used_at         timestamptz,
  expires_at      timestamptz not null
);

-- Access + refresh tokens, stored hashed. Both hang off the api_keys row the
-- grant minted; deleting or revoking that key ends every token.
create table if not exists oauth_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,
  kind         text not null,                -- access | refresh
  api_key_id   uuid not null references api_keys(id) on delete cascade,
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  resource     text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index if not exists oauth_tokens_api_key_idx on oauth_tokens (api_key_id);

alter table api_keys add column if not exists oauth_client_id text;

-- Service role only: these hold credential material.
alter table oauth_clients                enable row level security;
alter table oauth_authorization_requests enable row level security;
alter table oauth_tokens                 enable row level security;
