-- Brains (GET-431): the named places a workspace keeps what it knows. v1 seeds one, the GTM brain.
--
-- A brain is not a new store. Its written pages are documents (kind `brain_page`), filed by a
-- path inside the brain ("Playbooks/Competitors/Acme"); its playbooks read the GTM profile the
-- ICP model already scores against; its insights are the ones the background extractor writes.
-- This table only names the place and says what belongs in it.
--
-- Additive and idempotent: re-running is a no-op, and no existing document changes kind or home.
-- RLS on with no policy, like every service-role table here: the API is the only reader.

create table if not exists public.brains (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  slug          text not null,
  name          text not null,
  -- Which layout it was made from. The template decides the tree; the rows decide the words.
  template      text not null default 'gtm' check (template in ('gtm', 'blank')),
  -- What belongs here and what an agent should look for. Read before anything else in it.
  charter       text not null default '',
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (workspace_id, slug)
);
alter table public.brains enable row level security;

alter table public.documents add column if not exists brain_id uuid references public.brains(id) on delete set null;
alter table public.documents add column if not exists brain_path text;

-- One live page per path: the versions of "Decisions" are one page's history, not a pile.
create index if not exists documents_brain_path_idx
  on public.documents (brain_id, brain_path) where status = 'live' and brain_id is not null;

alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check
  check (kind in (
    'brief', 'plan', 'report', 'meeting_brief', 'objection_prep', 'call',
    'account_summary', 'call_summary', 'call_score', 'brain_page'
  ));
