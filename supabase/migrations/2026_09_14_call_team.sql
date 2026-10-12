-- Calls run by a team (GET-246).
--
--   team_user_ids  every teammate on the call. Coaching credits the call to each of them, not only
--                  to rep_user_id (the host: the calendar organizer, else whoever recorded it).
--   recordings     every note-taker recording of the call — [{source, meeting_id, url,
--                  named_speakers}] — so a second teammate's recording is listed on the page
--                  instead of being dropped.

alter table public.call_scorecards add column if not exists team_user_ids uuid[] not null default '{}';
alter table public.call_scorecards add column if not exists recordings    jsonb  not null default '[]'::jsonb;

-- Existing calls: the host is on the team.
update public.call_scorecards
   set team_user_ids = array[rep_user_id]
 where rep_user_id is not null and cardinality(team_user_ids) = 0;

create index if not exists call_scorecards_team
  on public.call_scorecards using gin (team_user_ids);

comment on column public.call_scorecards.team_user_ids is 'Every teammate on the call; Coaching credits the call to each (GET-246).';
comment on column public.call_scorecards.recordings is 'Every note-taker recording of the call: [{source, meeting_id, url, named_speakers}] (GET-246).';
