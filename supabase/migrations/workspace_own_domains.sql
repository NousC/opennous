-- The domains a workspace's own people use (GET-291).
--
-- Four separate bugs in one day came from code guessing at this fact: calls filed on a sibling
-- company, calls filed on the seller's own employee, a customer call dropped as "internal", and
-- two companies' calls merged because the only shared attendee was the CS manager who ran both.
-- Each place derived "is this person ours?" from whatever was nearby — a host's email, a seat
-- lookup, a contact's company row — and no two agreed.
--
-- The fact now has one home. Evidence, not configuration: rows are derived from seats and from the
-- accounts connected sources authenticate as, and a domain needs two independent sources (or a
-- person) before it counts.
create table if not exists public.workspace_own_domains (
  workspace_id  uuid        not null references public.workspaces(id) on delete cascade,
  domain        text        not null,
  -- Which evidence put it here: 'seat', 'source_account', or 'manual'. Kept so a wrong row can be
  -- explained and withdrawn rather than guessed at.
  sources       text[]      not null default '{}',
  confirmed_by  uuid        null references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, domain)
);

comment on table public.workspace_own_domains is
  'Domains whose email addresses belong to this workspace''s own people (GET-291). One home for a fact four call sites used to guess at.';

-- Every read is "the domains for this workspace", so the primary key already serves it. No extra
-- index: the table holds a handful of rows per workspace.
