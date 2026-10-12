-- Clean up duplicate LinkedIn message observations.
--
-- The webhook and backfill ingest paths keyed external_id on DIFFERENT message ids for
-- the same message (msg.id vs body.message_id), so the (workspace, source, external_id)
-- unique index never collapsed them and threads showed doubles. The ingest code is now
-- fixed to key external_id on the shared `provider_message_id`; this removes the rows
-- that were already duplicated, keeping the earliest copy per real message.
--
-- Destructive: review the SELECT count before running the DELETE.

-- How many rows will be removed:
--   select count(*) from (
--     select id, row_number() over (
--       partition by workspace_id, entity_id, raw->>'provider_message_id'
--       order by created_at asc, id asc) as rn
--     from observations
--     where property = 'interaction.linkedin_message'
--       and raw->>'provider_message_id' is not null
--   ) t where rn > 1;

with ranked as (
  select id, row_number() over (
    partition by workspace_id, entity_id, raw->>'provider_message_id'
    order by created_at asc, id asc
  ) as rn
  from observations
  where property = 'interaction.linkedin_message'
    and raw->>'provider_message_id' is not null
)
delete from observations
where id in (select id from ranked where rn > 1);
