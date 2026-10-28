-- Cause-and-effect links between claims (GET-1053). The extractor may say that one fact it read
-- happened BECAUSE of another in the same read ("we froze the budget after our CFO left": the budget
-- freeze caused_by the CFO leaving; "that settles it" after our security doc: the objection resolved
-- caused_by our reply). The worker maps the model's positions to claim ids once the facts are filed
-- (apps/worker/src/signals/causeLinks.mjs) and writes them here through packages/core/src/db/claimLinks.ts.
--
-- claim_links: one row per (workspace, from, to, kind). from_claim_id is the EFFECT, to_claim_id the
-- CAUSE ("from caused_by to"). Only 'caused_by' for now (Hindsight's retain writes only that form).
-- archived_at: set when either end is retired, cleared when it comes back (the trigger below), so a
-- link is history, never deleted, while its claims are.
--
-- The trigger: every path that retires a claim (retireNote, supersedeNote, updateNote, the re-read and
-- repair jobs) or brings one back (updateNote is_active true, the personal-facts re-read, the document
-- backfill) sets claims.invalid_at, so one AFTER UPDATE OF invalid_at trigger covers them all. It fires
-- only when invalid_at goes from null to set or back. A link comes back only when its other end is live.
--
-- Public: extraction is open-source code, and claims migrations are public. Service role only (RLS on,
-- no policies); the trigger function is SECURITY DEFINER so a retire by any role archives the links.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  from_claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  to_claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('caused_by')),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, from_claim_id, to_claim_id, kind)
);
CREATE INDEX IF NOT EXISTS claim_links_from_idx ON public.claim_links (from_claim_id);
CREATE INDEX IF NOT EXISTS claim_links_to_idx ON public.claim_links (to_claim_id);
ALTER TABLE public.claim_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_links_follow_claim() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.invalid_at IS NULL AND NEW.invalid_at IS NOT NULL THEN
    UPDATE public.claim_links SET archived_at = now()
     WHERE workspace_id = NEW.workspace_id AND archived_at IS NULL
       AND (from_claim_id = NEW.id OR to_claim_id = NEW.id);
  ELSIF OLD.invalid_at IS NOT NULL AND NEW.invalid_at IS NULL THEN
    UPDATE public.claim_links l SET archived_at = NULL
     WHERE l.workspace_id = NEW.workspace_id AND l.archived_at IS NOT NULL
       AND (l.from_claim_id = NEW.id OR l.to_claim_id = NEW.id)
       AND EXISTS (
         SELECT 1 FROM public.claims c
          WHERE c.id = CASE WHEN l.from_claim_id = NEW.id THEN l.to_claim_id ELSE l.from_claim_id END
            AND c.invalid_at IS NULL);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS claim_links_follow_claim ON public.claims;
CREATE TRIGGER claim_links_follow_claim AFTER UPDATE OF invalid_at ON public.claims
  FOR EACH ROW WHEN ((OLD.invalid_at IS NULL) IS DISTINCT FROM (NEW.invalid_at IS NULL))
  EXECUTE FUNCTION public.claim_links_follow_claim();

COMMIT;

NOTIFY pgrst, 'reload schema';
