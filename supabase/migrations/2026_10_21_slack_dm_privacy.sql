-- Slack DMs are private messages (GET-985).
--
-- A teammate can now connect their own Slack, and their DMs with customers are read like their
-- email: the whole team sees that the conversation happened and everything learned from it, and
-- only the people in it see what it said. This re-creates visible_observations_v2 from
-- 2026_09_14_message_privacy.sql with two more private properties, the DM itself and the
-- conversation snapshot a DM read files as evidence. Mirrors PRIVATE_MESSAGE_TYPES in
-- packages/core/src/privacy/messagePrivacy.mjs (change one, change both). Idempotent.

create or replace function public.visible_observations_v2(
  p_workspace_id uuid,
  p_entity_id uuid,
  p_viewer_user_id uuid,
  p_viewer_emails text[],
  p_viewer_is_admin boolean,
  p_property text default null,
  p_kind text default null,
  p_as_of timestamptz default null,
  p_limit int default 200
)
returns table (
  id uuid,
  entity_id uuid,
  kind text,
  property text,
  value jsonb,
  source text,
  method text,
  source_confidence double precision,
  observed_at timestamptz,
  ingested_at timestamptz,
  owner_user_id uuid,
  external_id text,
  source_ref text,
  redacted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select o.*,
           (o.property in (
              'interaction.email_sent', 'interaction.email_received', 'interaction.email_reply', 'interaction.email_replied',
              'interaction.linkedin_message', 'interaction.linkedin_message_sent', 'interaction.linkedin_message_received',
              'interaction.linkedin_replied', 'interaction.linkedin_reply',
              'interaction.linkedin_inmail', 'interaction.linkedin_inmail_sent', 'interaction.linkedin_inmail_received',
              'interaction.slack_dm', 'evidence.slack_dm_conversation'
            )) as is_message
    from public.observations o
    where o.workspace_id = p_workspace_id
      and o.entity_id = p_entity_id
      and (p_property is null or o.property = p_property)
      and (p_kind is null or o.kind = p_kind)
      and (p_as_of is null or o.observed_at <= p_as_of)
  ),
  judged as (
    select s.*,
           -- coalesce: any NULL in the chain (a legacy row without cc) must read as "not on it",
           -- never as an unknown that leaves `redacted` null.
           coalesce(not s.is_message
             or p_viewer_user_id is null
             or s.owner_user_id is null
             or s.owner_user_id = p_viewer_user_id
             or coalesce(s.raw -> 'mailbox_owner_ids', '[]'::jsonb) ? p_viewer_user_id::text
             or lower(coalesce(s.raw #>> '{participants,from}', s.raw ->> 'from', '')) = any(coalesce(p_viewer_emails, '{}'))
             or coalesce(s.raw #> '{participants,to}', '[]'::jsonb) ?| coalesce(p_viewer_emails, '{}')
             or coalesce(s.raw #> '{participants,cc}', '[]'::jsonb) ?| coalesce(p_viewer_emails, '{}')
             or (jsonb_typeof(s.raw -> 'to') = 'array' and (s.raw -> 'to') ?| coalesce(p_viewer_emails, '{}'))
             or (jsonb_typeof(s.raw -> 'cc') = 'array' and (s.raw -> 'cc') ?| coalesce(p_viewer_emails, '{}')),
           false) as content_ok
    from scoped s
  )
  select j.id, j.entity_id, j.kind, j.property,
         case when j.content_ok then j.value
              else jsonb_build_object(
                'description',
                case when j.property like 'interaction.email_%'
                     then 'Email ' || case when j.property like '%_sent' or (j.raw ->> 'is_outbound') = 'true' then 'sent' else 'received' end
                     when j.property in ('interaction.slack_dm', 'evidence.slack_dm_conversation')
                     then 'Slack message ' || case when (j.raw ->> 'is_outbound') = 'true' then 'sent' else 'received' end
                     else 'LinkedIn message ' || case when j.property like '%_sent' or (j.raw ->> 'is_outbound') = 'true' then 'sent' else 'received' end
                end,
                'summary', null)
         end as value,
         j.source, j.method, j.source_confidence, j.observed_at, j.ingested_at, j.owner_user_id,
         j.external_id, j.source_ref,
         not j.content_ok as redacted
  from judged j
  -- Which rows are returned at all: messages always (their content is judged above); anything
  -- else under the original rule — admin sees all, a member sees shared rows and their own.
  where j.is_message or p_viewer_is_admin or j.owner_user_id is null or j.owner_user_id = p_viewer_user_id
  order by j.observed_at desc
  limit least(coalesce(p_limit, 200), 5000);
$$;

comment on function public.visible_observations_v2(uuid, uuid, uuid, text[], boolean, text, text, timestamptz, int) is
  'Observations for one entity as a named viewer may see them. Message content (email / LinkedIn / Slack DM) is readable only by its participants and the members whose account holds a copy; everyone else gets the row with a label and redacted = true. Mirrors packages/core/src/privacy/messagePrivacy.mjs.';

grant execute on function public.visible_observations_v2(uuid, uuid, uuid, text[], boolean, text, text, timestamptz, int) to service_role;
