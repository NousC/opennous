-- Stated preferences, and the correction that produced them (GET-189).
--
-- Two stores, because they are two different claims and a single floor cannot serve both.
--
--   ri_observations  — patterns MINED from outcomes. "Follow-ups naming an objection book
--                      meetings at twice the rate." Needs n before it means anything, which is
--                      why the instruction floor sits at 30.
--   ri_preferences   — what a person SAID, or what one correction made obvious. "Write
--                      shorter." n is 1 and that is fine: the human told us. Putting these
--                      behind a statistical floor would mean ignoring someone who has already
--                      spoken, and letting mined patterns through at n=1 would mean acting on
--                      noise. Same block in the end, different provenance and different bar.
--
-- Scoped like constraints, and for the same reason: a preference is not a policy. There is no
-- 'everyone' scope — a preference that should apply to every customer is a product change.

create table if not exists public.ri_preferences (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  scope         text not null default 'person',   -- person | workspace
  user_id       uuid,                             -- required when scope = 'person'
  -- The instruction as the agent should read it, in the operator's terms.
  statement     text not null,
  -- What it governs, so a preference about email does not reshape a pipeline review.
  applies_to    text,                             -- artifact/action type, null = everything
  source        text not null default 'stated',   -- stated | inferred
  -- The decisions that produced it, so "why am I being written to like this" is answerable.
  evidence_ids  text[] not null default '{}',
  -- How many corrections have pointed the same way. One is enough to act on when the person
  -- said it outright; it is also worth knowing when three separate edits agreed, because that
  -- is a much stronger signal than a single offhand remark.
  observed_count integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  removed_at    timestamptz,
  removed_by    uuid,
  unique (workspace_id, scope, user_id, statement)
);
create index if not exists ri_preferences_lookup_idx
  on public.ri_preferences (workspace_id, scope, user_id) where removed_at is null;

-- What the correction MEANT, kept on the decision that produced it.
--
-- The interpretation has to be written at the moment it happens. A diff mined a week later
-- shows that a paragraph vanished; the agent that was present knows the user said "too pushy,
-- cut the pricing." Storing the meaning alongside the verdict is what makes the signal
-- reusable instead of archaeological.
alter table public.ri_decisions
  add column if not exists interpretation   text,
  -- rule | structure | claim | constraint | none — where the correction was routed. 'none' is
  -- a real answer and the most common one: most edits are a typo or a detail only the human
  -- knew, and treating those as preferences is how the instruction block fills with noise.
  add column if not exists correction_kind  text,
  -- once | person | workspace | product. 'product' means the user is telling us our default is
  -- wrong for everyone, which is a ticket for us rather than a row for them.
  add column if not exists correction_scope text;

create index if not exists ri_decisions_correction_idx
  on public.ri_decisions (workspace_id, correction_kind) where correction_kind is not null;

alter table public.ri_preferences enable row level security;
