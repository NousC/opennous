-- Share an account/person with a teammate. A row = "this record is shared with that
-- user"; it surfaces on the recipient's "Shared with me" page. entity_name is
-- denormalised so the Shared-with-me list needs no join back to the record.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

create table if not exists public.entity_shares (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id    text not null,                          -- companies.id or contacts.id
  entity_kind  text not null check (entity_kind in ('company','person')),
  entity_name  text,
  shared_by    uuid not null,                          -- who shared it
  shared_with  uuid not null,                          -- the teammate it's shared with
  created_at   timestamptz not null default now(),
  unique (workspace_id, entity_id, shared_with)
);

create index if not exists entity_shares_recipient
  on public.entity_shares (workspace_id, shared_with, created_at desc);
create index if not exists entity_shares_by_entity
  on public.entity_shares (workspace_id, entity_id);

alter table public.entity_shares enable row level security;

notify pgrst, 'reload schema';
