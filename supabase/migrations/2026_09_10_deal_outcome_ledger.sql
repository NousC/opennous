-- The outcome ledger: what actually happened, with what we knew AT THE TIME.
--
-- The ICP scoring model is currently fitted to nothing. Weights come from one LLM call over
-- the ICP and positioning notes — a language model's opinion about prose — and no deal
-- outcome ever touches them. This table is the missing input: a labelled row per closed deal,
-- so lift can be measured instead of guessed.
--
-- The column that makes it honest is `features_at`. An account's attributes are read as they
-- stood when the deal was CREATED, not as they stand now. Score a won account on attributes
-- it acquired after becoming a customer and the model's finding is "our ICP is companies who
-- are already our customers" — the classic leak. Claims are temporal (valid_from/invalid_at),
-- so the graph can answer "what did we know about Acme in March", which is the whole reason
-- this is possible here and not in a CRM.
create table if not exists public.deal_outcomes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  entity_id     uuid not null,

  -- won / lost / no_decision. The third is not a negative: a deal nobody decided on failed
  -- differently from one that was lost to a competitor, and the win/loss skill already keeps
  -- them apart. Folding them together would teach the model that indecision is rejection.
  outcome       text not null check (outcome in ('won', 'lost', 'no_decision')),

  opened_at     timestamptz,          -- when the deal became real; the point features are read at
  closed_at     timestamptz not null,
  value_usd     numeric,

  -- The account as it stood at `opened_at`: firmographic claims plus behaviour derived from
  -- the timeline (stakeholders, days to first meeting, follow-up latency…). Flat key→value,
  -- because the fitting step is arithmetic over categorical and boolean features, not a model.
  features_at   jsonb not null default '{}'::jsonb,

  -- Which pass produced this row, so a re-derivation can be compared with the one before it
  -- rather than silently replacing it.
  derived_at    timestamptz not null default now(),
  source        text not null default 'graph',

  unique (workspace_id, entity_id, closed_at)
);

create index if not exists deal_outcomes_ws_outcome_idx on public.deal_outcomes (workspace_id, outcome);
create index if not exists deal_outcomes_ws_closed_idx  on public.deal_outcomes (workspace_id, closed_at desc);

comment on table public.deal_outcomes is
  'Labelled closed deals with point-in-time account features. The evidence the ICP scoring model should be fitted to.';
comment on column public.deal_outcomes.features_at is
  'Account attributes as of opened_at, never as of now. Reading them as of now leaks the outcome into the features.';
