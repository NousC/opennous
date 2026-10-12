-- A seat promised on a sales call, waiting for its person to arrive.
--
-- Signing up puts you on a core plan — the plugin experience, no in-app agent — which is the
-- right default for someone who found the product on their own. It is the wrong one for a
-- team that has just been sold the Custom plan: they arrive, land on an Install page for a
-- CLI they were never pitched, and someone has to fix it by hand while they watch.
--
-- So the sale writes the seat down first. When that email signs in, the plan, the workspace
-- role and the lens are already theirs.
create table if not exists public.pending_seats (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  plan_id      text not null default 'custom',
  member_role  text not null default 'owner' check (member_role in ('owner', 'admin', 'member', 'viewer')),
  job_roles    text[] not null default array['ambassador'],
  workspace_id uuid references public.workspaces(id) on delete cascade,
  note         text,
  created_by   uuid,
  claimed_at   timestamptz,
  claimed_by   uuid,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists pending_seats_email_unclaimed
  on public.pending_seats (lower(email)) where claimed_at is null;

comment on table public.pending_seats is
  'Emails pre-authorised on a sales call. Applied at first sign-in: plan, workspace role and lens.';

-- What we already know about them from the sales call. The first message should not open by
-- asking for things a salesperson wrote down last week.
alter table public.pending_seats
  add column if not exists person_name  text,
  add column if not exists company_name text,
  add column if not exists company_site text;
