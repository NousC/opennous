-- CLI / plugin browser-login (device-authorization) pairing requests.
--
-- Flow: the CLI calls /api/cli/auth/start → a row is created with a secret
-- device_code (the CLI polls with it) and a short user_code (embedded in the
-- browser URL). The signed-in user approves at /cli-login, which mints an API
-- key for their workspace and stashes the raw key here transiently. The CLI's
-- next poll returns the key once, then the row is consumed (raw_key cleared).
create table if not exists cli_auth_requests (
  id            uuid primary key default gen_random_uuid(),
  device_code   text not null unique,
  user_code     text not null,
  status        text not null default 'pending', -- pending | approved | denied | consumed
  workspace_id  uuid references workspaces(id) on delete cascade,
  api_key_id    uuid,
  raw_key       text,           -- transient: present only between approve and the first poll
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  expires_at    timestamptz not null
);

create index if not exists cli_auth_requests_user_code_idx   on cli_auth_requests (user_code);
create index if not exists cli_auth_requests_device_code_idx on cli_auth_requests (device_code);
