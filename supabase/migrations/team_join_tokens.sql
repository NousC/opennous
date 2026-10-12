-- Reusable, owner-issued join tokens for CLI self-provisioning (docs/api-plan-cli-join.md).
-- Distinct from single-use email team_invitations: a token can be shared, domain-locked,
-- use-capped, and revoked, and a member redeems it over the CLI device-auth flow
-- (`npx @opennous/cli join <token>`). Idempotent — safe to re-run.
create table if not exists public.team_join_tokens (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  token text not null unique,
  role text not null default 'member',           -- role granted on join (member | viewer)
  domain text,                                    -- optional: only <name>@domain may redeem
  max_uses integer,                               -- optional cap; null = unlimited
  uses integer not null default 0,
  member_credit_budget integer,                   -- optional per-member credit ceiling (phase 2)
  created_by uuid references public.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists team_join_tokens_team_idx
  on public.team_join_tokens(team_id) where revoked_at is null;

-- The CLI join flow rides the existing device-auth request; remember which join token
-- a request is redeeming so the browser-side approve step attaches to the right team.
alter table public.cli_auth_requests add column if not exists join_token text;
