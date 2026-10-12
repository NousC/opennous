-- What a condition watch does when it fires: draft the next move (default, runs the
-- routine prompt) OR start a durable motion play on the account (watches -> plays).
alter table public.agent_routines add column if not exists action jsonb;
comment on column public.agent_routines.action is
  'For condition watches: what to do when it fires. null/{kind:"draft"} = run the prompt (draft the next move); {kind:"play","play":"nurture"} = start a durable motion play on the account (autopilot).';
