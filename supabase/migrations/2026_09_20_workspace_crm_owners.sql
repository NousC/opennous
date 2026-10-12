-- Who a Nous member is, in the CRM's terms.
--
-- Every list that says "yours" needs this one join and there is nowhere to put it today. A deal
-- says `owner_name: 'Corin Ashdale'` and an account says the same; a session says a Supabase user
-- id. Those are unrelated strings until a row here says they are one person, which is why owner
-- scoping cannot ship as a query change alone.
--
-- Small by design: the largest customer has a couple of dozen active CRM owners and about half hold an open deal. This is a
-- settings screen someone fills once, not a sync.
--
-- `owner_email` is the join that cannot be wrong and is matched automatically. `owner_name` is
-- what the deal and account rows actually carry, and a CRM's display name drifts from its login,
-- so both are kept.
--
-- `matched_by` records whether a person confirmed the row or we inferred it, so the settings
-- screen can show which mappings are guesses. An unmapped member is not an error: the lists fail
-- OPEN and they see the workspace, exactly as they do today.

create table if not exists public.workspace_crm_owners (
  workspace_id uuid        not null references public.workspaces(id) on delete cascade,
  user_id      uuid        not null,
  owner_email  text,
  owner_name   text,
  matched_by   text        not null default 'manual' check (matched_by in ('manual', 'email')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- One CRM owner belongs to at most one member: two members claiming `Corin Ashdale` would each see
-- a different half of his book with no way to tell.
create unique index if not exists workspace_crm_owners_email_unique
  on public.workspace_crm_owners (workspace_id, lower(owner_email)) where owner_email is not null;
create unique index if not exists workspace_crm_owners_name_unique
  on public.workspace_crm_owners (workspace_id, lower(owner_name)) where owner_name is not null;

alter table public.workspace_crm_owners enable row level security;
