-- Campaign message copy — the email text per (campaign, step, variant).
--
-- Keyed by the sequencer's campaign id so it joins directly to the
-- `interaction.email_sent` / reply observation's rawData attribution
-- (campaign_id, step, variant). This is the "which email earned the reply"
-- copy store. Reference data like lead_suppressions — not part of the entity
-- substrate; the API enforces workspace scope.
--
-- Populated three ways: passively from sent webhooks (when the provider
-- includes the body), and actively from the sequencer API or the campaign
-- writer skill (POST /api/campaign-messages). Safe to re-run.

create table if not exists campaign_messages (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references workspaces(id) on delete cascade,
  provider      text        not null default 'unknown',  -- instantly|lemlist|smartlead|manual|campaign_writer
  campaign_id   text        not null,                     -- the sequencer's campaign id
  campaign_name text,
  step          text        not null default '',          -- sequence step ('' when not provided)
  variant       text        not null default '',          -- A/B variant ('' when not provided)
  subject       text,
  body          text,
  source        text        not null default 'webhook',   -- where the copy came from
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, provider, campaign_id, step, variant)
);

create index if not exists campaign_messages_ws
  on campaign_messages (workspace_id, created_at desc);

drop trigger if exists campaign_messages_updated_at on campaign_messages;
create trigger campaign_messages_updated_at
  before update on campaign_messages
  for each row execute function update_updated_at_column();
