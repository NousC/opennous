-- Market entities (GET-1049): one canonical name per competitor, tool or product named in customer
-- conversations. Claims keep their free text (value.metadata.entity / .tool) and gain
-- value.metadata.market_entity_id, written by saveNote (packages/core/src/db/marketEntities.ts), so
-- the insight engine and the battlecards file count "Hubspot", "HubSpot's" and "Hub Spot" once.
--
-- market_entities: the canonical row. normalized_key is the name as the matcher keys it (lowercase,
-- accents and punctuation off, possessive dropped). mention_count / first_seen / last_seen are bumped
-- on every claim that resolves to it. parent_id is a product line's parent ("HubSpot MCP" under
-- "HubSpot"), merged_into_id a merged-away duplicate's survivor. proposed_same_as is the matcher's
-- open question: a name too close to call ('ask') is created as its own entity with the candidate it
-- may be, for a model or a person to settle (follow-up).
-- market_entity_aliases: every spelling seen, one owner per (workspace, kind, spelling).
--
-- Public: the insight engine and extraction are open-source code. Service role only (RLS on, no
-- policies). Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.market_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('competitor', 'tool', 'product')),
  canonical_name text NOT NULL,
  normalized_key text NOT NULL,
  parent_id uuid REFERENCES public.market_entities(id) ON DELETE SET NULL,
  mention_count integer NOT NULL DEFAULT 0,
  first_seen timestamptz,
  last_seen timestamptz,
  merged_into_id uuid REFERENCES public.market_entities(id) ON DELETE SET NULL,
  proposed_same_as uuid REFERENCES public.market_entities(id) ON DELETE SET NULL,
  proposed_score real,
  proposed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, normalized_key)
);
CREATE INDEX IF NOT EXISTS market_entities_proposed_idx ON public.market_entities (workspace_id, kind)
  WHERE proposed_same_as IS NOT NULL;
ALTER TABLE public.market_entities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.market_entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES public.market_entities(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('competitor', 'tool', 'product')),
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'llm', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, normalized_alias)
);
CREATE INDEX IF NOT EXISTS market_entity_aliases_entity_idx ON public.market_entity_aliases (entity_id);
ALTER TABLE public.market_entity_aliases ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
