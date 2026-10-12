-- A record's intel, grouped into topics (the Intel tab on accounts, deals and people).
--
-- The facts stay where they are (claims, note.*). This row is a projection over them: which facts
-- are about the same thing ("QR Codes", "Harborline Lead Routing"), which of those facts restate
-- each other, and one sentence on where the topic stands now. Rebuilt when the record's fact set
-- changes; losing it costs one model call, never a fact.
--
-- topics: [{ label, kind, summary, facts: [[claim id, restating claim id, …], …] }]
-- fact_hash: sha1 of the sorted fact ids it was built from, so an unchanged record is never re-read.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

create table if not exists public.intel_topics (
  workspace_id uuid not null,
  entity_id    uuid not null,
  topics       jsonb not null default '[]'::jsonb,
  fact_hash    text not null,
  fact_count   int not null default 0,
  model        text,
  computed_at  timestamptz not null default now(),
  primary key (workspace_id, entity_id)
);

alter table public.intel_topics enable row level security;

notify pgrst, 'reload schema';
