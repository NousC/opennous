-- Which Linear issue an Insights topic was sent to (GET-825).
--
-- One row per (workspace, topic): sending a topic again adds to the same issue instead of filing a
-- second one. The row is also the send's lock: a send claims it ('pending', claimed_at) before it
-- calls Linear, and fills in the issue the moment the issue exists ('linked'). A claim older than
-- two minutes was left by a crashed send and may be taken over (packages/core/src/db/linearIssueLinks.ts).
-- sent_item_ids are the insight_items already sent as Linear customer requests, so a re-send only
-- adds the new ones. `state` is Linear's workflow state type (triage, backlog,
-- unstarted, started, completed, canceled), filled by the status sync once it lands.
--
-- topic_key is the board row key: '<subtype>|<tag id>', as insight_topic_state uses it.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

create table if not exists public.linear_issue_links (
  workspace_id     uuid not null,
  topic_key        text not null,
  status           text not null default 'pending' check (status in ('pending','linked')),
  linear_issue_id  text,                           -- null only while pending
  identifier       text,                           -- e.g. PRD-12
  url              text,
  team_id          text,
  state            text,
  sent_item_ids    text[] not null default '{}',
  created_at       timestamptz not null default now(),
  last_sent_at     timestamptz not null default now(),
  last_sent_by     uuid,
  claimed_at       timestamptz,                    -- set while a send holds the topic
  state_synced_at  timestamptz,
  primary key (workspace_id, topic_key)
);

-- The status sync finds the topic from Linear's issue id.
create index if not exists linear_issue_links_issue_idx on public.linear_issue_links (linear_issue_id);

alter table public.linear_issue_links enable row level security;

notify pgrst, 'reload schema';
