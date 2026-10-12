-- Who on the team owns an Insights topic (workspace redesign Phase 3.7).
--
-- A topic already carries the team's status, priority and notes (2026_09_25_insight_topic_state.sql).
-- This adds the one person who answers for it, picked from the workspace's members on the topic's
-- page. Nullable: a topic nobody has picked up has no owner, and the page says "No owner" rather
-- than guessing one.
--
-- No foreign key, the same as updated_by beside it: the API checks membership when the owner is
-- set, and a member who later leaves the workspace should leave the topic reading "No owner" on
-- the page, not block their removal.
--
-- SAFE TO RUN TWICE. Adds one nullable column; drops and rewrites nothing. Apply in the Supabase
-- SQL editor; it ends with NOTIFY pgrst so the API sees the column without a restart.

set lock_timeout = '5s';

alter table public.insight_topic_state add column if not exists owner_user_id uuid;

comment on column public.insight_topic_state.owner_user_id is
  'The workspace member who owns this topic (users.id). Set from the topic page; null until someone is picked.';

notify pgrst, 'reload schema';
