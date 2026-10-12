-- Account memory — each account's living notebook of atomic, dated facts that the
-- agent maintains as its working model of the RELATIONSHIP. This is deliberately NOT
-- the context graph. The graph (observations -> claims) holds what is TRUE about the
-- customer, derived from evidence, with provenance and freshness/decay. Memory holds
-- what we have LEARNED about WORKING the account: strategy, inferred preferences, what
-- we tried, what to do or not do next. It is agent-authored judgment, held until it
-- changes, never decayed. Kept in its own table so the graph's core guarantee — every
-- claim traces back to a source observation — stays intact and is never polluted with
-- synthesized opinion.
create table if not exists public.account_memory (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The account this memory belongs to (an entity: a company or a person).
  entity_id    uuid not null,
  -- One atomic fact per row (QM-style), so memory stays legible, diffable, and small
  -- enough to inject into every agent turn without a vector search.
  text         text not null,
  -- Who wrote it. 'agent' = the agent learned it in a conversation; 'human' = a member
  -- added it by hand on the account page.
  source       text not null default 'agent' check (source in ('agent','human')),
  captured_at  timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now()
);

create index if not exists account_memory_ws_entity_idx
  on public.account_memory (workspace_id, entity_id, captured_at desc);

comment on table public.account_memory is
  'Per-account living notebook of atomic, dated facts the agent maintains as its working model of the relationship. Separate from the context graph (evidence-derived customer truth); memory is agent-authored judgment about how we work the account, held until it changes, never decayed.';

-- Service-role only (the API), same posture as personal_files. RLS-on with no policy
-- blocks any anon/authenticated PostgREST access, so a leaked anon key cannot read it.
alter table public.account_memory enable row level security;
