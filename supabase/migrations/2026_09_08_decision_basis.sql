-- What a recommendation RESTED ON — the missing middle of the trust chain (GET-60).
--
-- Three trust gaps, and until now we handled two:
--   the fact        — where did this come from?     → provenance + the agent's citation
--   THE REASONING   — why does this fact imply      → nothing
--                     this action?
--   the track record— has advice like this worked?  → the decision loop
--
-- Both ends, no middle. The evidence layer can show a rep the exact quote and who said it.
-- The decision loop can say "advice of this category converts at X". Nothing connected a
-- SPECIFIC fact to the SPECIFIC action taken because of it.
--
-- Without the link we can grade ADVICE. With it we can grade EVIDENCE — which is the more
-- valuable of the two, because it feeds back into what the extractor should bother pulling
-- out at all. "Which risk signals genuinely predict slippage?" is unanswerable today not for
-- lack of outcomes, but because no signal is ever tied to an action taken on account of it.
--
-- Separate migration rather than a revision of 2026_09_08_decision_loop.sql: that one is
-- applied to prod, so it is now history and must not be edited.

alter table public.ri_decisions
  -- The claim / observation / note ids the recommendation rested on. Same convention as
  -- ri_behaviors.evidence_ids, which already does exactly this for behaviours.
  add column if not exists evidence_ids text[] not null default '{}',
  -- WHY we think it will work, kept separate from `proposal` (WHAT we are doing).
  -- `proposal` today reads "follow up naming the security objection they raised on the 3rd" —
  -- already a hypothesis, sitting in prose nothing parses. Splitting them lets the loop grade
  -- reasoning as a class, not just actions.
  add column if not exists rationale text;

-- Find every decision that rested on a given piece of evidence. This is the index that makes
-- "when we acted on an objection, what happened?" a query rather than a table scan.
create index if not exists ri_decisions_evidence_idx
  on public.ri_decisions using gin (evidence_ids);
