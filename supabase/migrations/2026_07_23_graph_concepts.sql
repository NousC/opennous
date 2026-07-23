-- The revenue entity graph.
--
-- claim_patterns clustered WHOLE claims into buckets — better than the old keyword
-- counting, but still a cluster view, not a knowledge graph. A claim is a container
-- (like an Obsidian note); the atoms are the revenue ENTITIES inside it — the pain,
-- the tool, the objection, the champion, the warm path. This table stores those
-- extracted, canonicalized entities as typed nodes that many accounts point to, so
-- "data fragmentation" becomes ONE node linking Ramp + Deel + Acme (same meaning,
-- however they phrased it) instead of three unlinked cluster spokes.
--
-- Each node is REVENUE-TYPED — the type IS the action: pain=wedge, tool=displace/
-- integrate, objection=rebuttal, play=timing, person=who-signs, connection=warm-path,
-- channel=attribution, segment=lookalike, competitor=win/loss. Written by
-- apps/worker/src/computeConcepts.mjs; read by graph.mjs to draw the typed web.
--
-- Recomputed whole each run (generation stamp; reader takes max per workspace).

CREATE TABLE IF NOT EXISTS public.graph_concepts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  type         text NOT NULL,                 -- pain | tool | competitor | objection | play | person | connection | channel | segment
  label        text NOT NULL,                 -- canonical short name, deduped across accounts
  entity_ids   uuid[] NOT NULL DEFAULT '{}',  -- accounts that point to this concept
  claim_ids    uuid[] NOT NULL DEFAULT '{}',  -- the claims it was extracted from (evidence)
  size         int  NOT NULL DEFAULT 0,       -- distinct-account count
  generation   bigint NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS graph_concepts_ws_gen ON public.graph_concepts(workspace_id, generation DESC);

-- Backend-only (worker writes, API reads, both service-role); RLS on, no policies.
ALTER TABLE public.graph_concepts ENABLE ROW LEVEL SECURITY;
