-- What the team decided about an Insights topic: its status (New → Aware → In progress → Shipped /
-- Fixed, or Won't do), its priority (Urgent · High · Medium · Low), and the team's own notes.
--
-- Kept apart from what the agent writes: the topic's headline, problems and quotes come from the
-- nightly worker (insight_rows / insight_items) and nobody can change or delete them. This row is
-- the people's side of the topic, so editing it can only ever touch the people's side.
--
-- One row per (workspace, topic), shared with the workspace; the last writer is recorded.
-- topic_key is the board row key the page already uses: '<subtype>|<tag id>'. priority is null
-- until someone sets it: the page suggests one from recent mentions until then.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

create table if not exists public.insight_topic_state (
  workspace_id uuid not null,
  topic_key    text not null,
  status       text not null default 'new' check (status in ('new','aware','in_progress','shipped','fixed','wont_do')),
  priority     text check (priority in ('urgent','high','medium','low')),
  notes        text not null default '',
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, topic_key)
);

alter table public.insight_topic_state enable row level security;

-- The agent's recommendation for a topic: what to do about it, written on request from the topic's
-- own insights. Agent-written like insight_rows, so the page shows it read-only; people respond to
-- it with a note, never by editing it. `refs` are the conversations it cites, in marker order:
-- [1] in the text is refs[0]. Stored as refs, not numbers, so a citation still points at the same
-- call after new insights arrive and the page renumbers its sources.

create table if not exists public.insight_topic_recommendations (
  workspace_id uuid not null,
  topic_key    text not null,
  summary      text not null,
  actions      jsonb not null default '[]'::jsonb,   -- [{ title, detail, sources: [1, 3] }]
  refs         text[] not null default '{}',
  item_count   int not null default 0,              -- insights it was written from
  created_at   timestamptz not null default now(),
  primary key (workspace_id, topic_key)
);

alter table public.insight_topic_recommendations enable row level security;

notify pgrst, 'reload schema';
