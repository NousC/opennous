-- Per-campaign provider analytics (sent/opened/replied/opportunities), pulled from
-- the sequencer's own analytics API. The TRUE denominators the reply sample can't
-- give us. Keyed by (workspace, provider, campaign_id); refreshed on read (24h TTL)
-- and by a daily cron. Reference data — not part of the entity substrate.
create table if not exists campaign_stats (
  workspace_id       uuid        not null references workspaces(id) on delete cascade,
  provider           text        not null default 'instantly',
  campaign_id        text        not null,
  campaign_name      text,
  status             integer,                       -- provider campaign status code
  leads_count        integer,                       -- total leads in the campaign
  sent_count         integer,                       -- emails_sent_count (the send denominator)
  contacted_count    integer,                       -- new_leads_contacted_count (unique leads)
  reply_count        integer,                       -- reply_count_unique
  opportunity_count  integer,                       -- total_opportunities (provider-marked positive)
  bounced_count      integer,
  unsubscribed_count integer,
  open_count         integer,                       -- open_count_unique
  raw                jsonb,                          -- full analytics blob
  fetched_at         timestamptz not null default now(),
  primary key (workspace_id, provider, campaign_id)
);

create index if not exists campaign_stats_ws on campaign_stats (workspace_id, fetched_at desc);
