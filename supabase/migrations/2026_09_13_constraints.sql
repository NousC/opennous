-- Constraints — the things this operator does not do (GET-190).
--
-- Every operator has a move they refuse. "I don't send breakup emails." "I never ask for a
-- call on a first touch." "We don't name competitors." Today we suggest it, they refuse it,
-- and we suggest it again next week, which reads as not listening because it is.
--
-- A constraint is a FILTER, not a line in a prompt. That distinction is the whole point of
-- this table. A prohibition asked of a model holds most of the time, and the exception is the
-- moment someone stops trusting the system — they will not report it, they will just start
-- ignoring suggestions. Where we generate server-side we refuse to generate at all; where the
-- agent generates on the user's own machine we can only instruct, and we record the violation
-- so the difference between the two is measurable rather than assumed.
--
-- Scoped, because a preference is not a policy. One rep refusing breakup emails says nothing
-- about their colleague.

create table if not exists public.ri_constraints (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  -- 'person' constraints bind to one operator; 'workspace' binds to everyone in it. There is
  -- deliberately no 'global' — a constraint that should apply to every customer is a product
  -- change and belongs in a skill, not in a row someone inferred from three refusals.
  scope         text not null default 'person',   -- person | workspace
  user_id       uuid,                             -- required when scope = 'person'
  -- What is refused, in the operator's own terms. This is what the agent reads, so it is a
  -- sentence rather than an enum: "never send breakup emails" carries more than a flag can.
  statement     text not null,
  -- Optional narrowing, so a constraint about email does not silently block a LinkedIn note.
  action_type   text,                             -- email_send | linkedin_message | campaign_add | ...
  category      text,                             -- outreach | follow_up | ...
  -- How we came to believe it. 'explicit' is the operator saying so; 'inferred' is us deciding
  -- from repeat refusals, which is a weaker claim and should be presented as one.
  source        text not null default 'explicit', -- explicit | inferred
  -- The decisions that produced an inferred constraint, so "why am I seeing this" is always
  -- answerable and the user can judge whether three refusals really meant never.
  evidence_ids  text[] not null default '{}',
  created_at    timestamptz not null default now(),
  -- Soft removal. A constraint the user lifted is itself a signal — we inferred wrongly — and
  -- deleting the row would throw away the correction along with the mistake.
  removed_at    timestamptz,
  removed_by    uuid,
  unique (workspace_id, scope, user_id, statement)
);
create index if not exists ri_constraints_lookup_idx
  on public.ri_constraints (workspace_id, scope, user_id) where removed_at is null;

alter table public.ri_constraints enable row level security;
