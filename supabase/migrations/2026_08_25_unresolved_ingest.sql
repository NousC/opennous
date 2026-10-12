-- Unresolved-ingest queue.
--
-- When an inbound source (today: a Fireflies meeting transcript) is received but
-- resolves to ZERO contacts even though it clearly had an external party, the
-- event is currently dropped after a "0 contacts updated" log line — silently
-- lost. This table captures those so an agent can list them, decide who each one
-- belongs to, and resolve it — which re-runs the normal ingest pipeline (activity
-- + notes + claim/insight extraction + evidence) against the chosen contact.
--
-- Scoped to meetings for v1; `source`/`kind` leave room for email/LinkedIn later.
create table if not exists unresolved_ingest (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  source            text not null,                       -- 'fireflies'
  kind              text not null default 'meeting',     -- 'meeting'
  external_id       text,                                -- provider meeting id
  title             text,
  occurred_at       timestamptz,
  detected_names    text[] not null default '{}',        -- attendee + speaker names we saw
  detected_emails   text[] not null default '{}',        -- non-host attendee emails we saw
  summary           text,                                -- digest/overview for the agent to eyeball
  raw               jsonb,                               -- minimal re-fire payload, e.g. { meeting_id }
  status            text not null default 'pending',     -- pending | resolved | dismissed
  resolved_entity_id uuid,
  resolved_at       timestamptz,
  last_seen_at      timestamptz not null default now(),  -- bumped on each re-delivery
  created_at        timestamptz not null default now(),
  unique (workspace_id, source, external_id)
);

create index if not exists unresolved_ingest_ws_status
  on unresolved_ingest (workspace_id, status, last_seen_at desc);
