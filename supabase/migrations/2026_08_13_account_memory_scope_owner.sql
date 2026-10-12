-- The scope line on account memory: NULL = company-shared (the team's working model of the
-- account, the default); set = PERSON-scoped, private to that member. Read = shared OR own.
alter table public.account_memory add column if not exists owner_user_id uuid;
comment on column public.account_memory.owner_user_id is
  'Scope: NULL = company-shared account memory (default). Set = person-scoped, private to that user (private notes / personal-agent memory). Read = owner_user_id IS NULL OR = the viewing member.';
create index if not exists account_memory_owner_idx
  on public.account_memory (workspace_id, entity_id, owner_user_id);
