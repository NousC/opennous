-- Personal and shared RevPlays (GET-1087). user_id says who made a row, on every row, so it cannot
-- say whose it is. Everything that exists stays shared; a personal play is visible only to user_id.
alter table public.agent_routines
  add column if not exists visibility text not null default 'shared'
  check (visibility in ('shared', 'personal'));

comment on column public.agent_routines.visibility is
  'shared: every member sees it, admins edit it. personal: only user_id sees and edits it, and it runs as them.';

create index if not exists agent_routines_personal_idx
  on public.agent_routines (workspace_id, user_id) where visibility = 'personal';
