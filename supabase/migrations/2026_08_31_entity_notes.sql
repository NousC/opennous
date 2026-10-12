-- Granola-style editable notes on an account or person. One evolving note doc per
-- (workspace, entity, user) — the member's own working note on that account, edited in
-- place with autosave (NOT the append-only claim/document notes the agent writes). This
-- is the human's canvas; the agent's extracted facts live alongside it on the same record.
--
-- Keyed by the record id the UI already has (companies.id / contacts.id) + a kind, so it
-- needs no graph-entity resolution. Sharing (visibility to teammates) layers on later.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

create table if not exists public.entity_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id    text not null,                       -- companies.id or contacts.id
  entity_kind  text not null check (entity_kind in ('company','person')),
  user_id      uuid not null,                       -- the note's author/owner
  title        text,
  body         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, entity_id, user_id)
);

create index if not exists entity_notes_lookup
  on public.entity_notes (workspace_id, entity_id, user_id);

alter table public.entity_notes enable row level security;

notify pgrst, 'reload schema';
