-- §5b Layer-B for the COMPANY vault: automatic inbound sync. Mirrors personal_workspaces —
-- a per-source sync_token (the unguessable webhook URL path), an auto_sync switch, and a
-- last_polled_at claim for the poll fallback. webhook_id + webhook_secret already exist.
alter table public.company_workspaces
  add column if not exists sync_token     text,
  add column if not exists auto_sync      boolean not null default true,
  add column if not exists last_polled_at timestamptz;

create unique index if not exists company_workspaces_sync_token_idx
  on public.company_workspaces (sync_token) where sync_token is not null;

comment on column public.company_workspaces.sync_token is 'Unguessable token in the GitHub webhook URL (/api/company/github/webhook/<sync_token>); the HMAC over webhook_secret is the real auth.';
