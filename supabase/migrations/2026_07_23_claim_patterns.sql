-- Claim-derived patterns: the honest "pattern" layer for the context graph.
--
-- The graph's old "Group by Pattern" clustered accounts by EXACT-MATCH frequency
-- of extracted graph-edge object_labels (Clay, "agency", "software", and the odd
-- raw claim fragment). That is keyword counting, not pattern detection — it can't
-- see that Ramp's "seven-tool stack, no unified view" and Deel's "region-specific
-- stacks, no unified view" are the SAME pattern (zero shared keywords), and it
-- emits generic-noun hubs nobody asked for.
--
-- Claims are the product's USP: raw data -> background reasoning -> claims. So the
-- pattern layer should cluster on the MEANING of the claims. This table stores the
-- output of that clustering (see apps/worker/src/computePatterns.mjs): each row is
-- a semantic cluster of Intel claims that spans >=2 distinct accounts, labelled and
-- quality-graded. The graph reads these instead of counting edge-labels.
--
-- Recomputed as a whole each run: a run stamps every row it writes with the same
-- `generation`, and the reader takes the max generation per workspace, so a partial
-- or failed run never mixes with the last good one.

CREATE TABLE IF NOT EXISTS public.claim_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  label        text NOT NULL,                 -- 3-6 word theme, LLM-generated
  category     text,                           -- dominant claim category (pain, objection, status_quo, …)
  kind         text,                           -- structural class: stack | pain | intent | segment | theme
  quality      text NOT NULL DEFAULT 'strong', -- strong | weak | noise
  why          text,                           -- one line: what the claims share
  entity_ids   uuid[] NOT NULL DEFAULT '{}',   -- the distinct accounts in the pattern
  claim_ids    uuid[] NOT NULL DEFAULT '{}',   -- the member claims (evidence)
  size         int  NOT NULL DEFAULT 0,        -- distinct-account count
  generation   bigint NOT NULL DEFAULT 0,      -- run stamp; reader takes max per workspace
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_patterns_ws_gen ON public.claim_patterns(workspace_id, generation DESC);

-- Backend-only table: written by the worker, read by the API — both use the service
-- role, which bypasses RLS. Enable RLS with NO policies so the anon/authenticated
-- roles cannot read it directly (the graph is served through the API, not PostgREST).
ALTER TABLE public.claim_patterns ENABLE ROW LEVEL SECURITY;
